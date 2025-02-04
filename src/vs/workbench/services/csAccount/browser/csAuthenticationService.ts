/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CSAuthenticationSession, CSUserProfileResponse, EncodedCSTokenData, GetSessionOptions, ICSAuthenticationService, SubscriptionResponse } from '../../../../platform/codestoryAccount/common/csAccount.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService, NotificationPriority } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IThemeService, Themable } from '../../../../platform/theme/common/themeService.js';
import { IURLService } from '../../../../platform/url/common/url.js';

class CSAuthenticationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CSAuthenticationError';
	}
}

const SESSION_SECRET_KEY = 'codestory.auth.session';

export class CSAuthenticationService extends Themable implements ICSAuthenticationService {
	declare readonly _serviceBrand: undefined;

	private _onDidAuthenticate: Emitter<CSAuthenticationSession> = this._register(new Emitter<CSAuthenticationSession>());
	readonly onDidAuthenticate: Event<CSAuthenticationSession> = this._onDidAuthenticate.event;

	private _subscriptionsAPIBase: string | null = null;
	private _websiteBase: string | null = null;

	private _pendingStates: string[] = [];
	private _session: CSAuthenticationSession | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IProgressService private readonly progressService: IProgressService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IURLService private readonly urlService: IURLService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(themeService);

		const isDevelopment = !this.environmentService.isBuilt || this.environmentService.isExtensionDevelopment;
		if (isDevelopment) {
			this._subscriptionsAPIBase = 'http://localhost:3333'; // @g-danna need to change back to 'https://staging-api.codestory.ai'
			this._websiteBase = 'https://staging.aide.dev';
		} else {
			this._subscriptionsAPIBase = 'https://api.codestory.ai';
			this._websiteBase = 'https://aide.dev';
		}

		CommandsRegistry.registerCommand('codestory.refreshTokens', async () => {
			await this.refreshTokens();
		});

		this.urlService.create({ path: '/authenticate-codestory' });
		this.initialize();
	}

	private async initialize(): Promise<void> {
		const session = await this.secretStorageService.get(SESSION_SECRET_KEY);
		this._session = session ? JSON.parse(session) : undefined;
		await this.refreshTokens();
	}

	private readonly MAX_REFRESH_RETRIES = 3;

	async refreshTokens(): Promise<void> {
		if (!this._session) {
			return;
		}

		let attempts = 0;
		let lastError: unknown;

		while (attempts < this.MAX_REFRESH_RETRIES) {
			try {
				const response = await fetch(`${this._subscriptionsAPIBase}/v1/auth/refresh`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						refresh_token: this._session.refreshToken
					}),
				});

				if (response.ok) {
					// Successfully got a new token
					const data = (await response.json()) as EncodedCSTokenData;
					await this.getSessionData(this._session.id, data);
					this.scheduleRefresh(data.access_token);
					return;  // Done refreshing
				} else if (response.status === 401) {
					// The refresh token is truly invalid or expired
					this.notificationService.notify({
						severity: Severity.Error,
						message: 'Your CodeStory session has expired. Please sign in again.',
						priority: NotificationPriority.URGENT,
					});
					await this.deleteSession();
					throw new Error('Refresh token invalid or expired');
				} else if (response.status >= 500) {
					// Likely a transient server error, let's retry
					lastError = new Error(`Server error ${response.status}, attempt ${attempts + 1}`);
				} else {
					// Some other 4XX error - possibly a misconfiguration or something else
					lastError = new Error(`Unexpected HTTP ${response.status} on refresh, attempt ${attempts + 1}`);
				}
			} catch (err) {
				// Could be network error, DNS, etc.
				lastError = err;
			}

			attempts++;
			await delay(1000 * attempts);
		}

		this.notificationService.notify({
			severity: Severity.Error,
			message: `Failed to refresh CodeStory session after ${this.MAX_REFRESH_RETRIES} attempts. Please check your internet or try again later.`,
		});

		// await this.deleteSession();
		throw lastError;
	}

	private scheduleRefresh(
		token: string,
	) {
		try {
			const payload = decodeJwtPayload(token);
			const expirationMs = payload.exp * 1000; // "exp" in JWT is in seconds since Unix epoch
			const nowMs = Date.now();
			const msUntilExpiry = expirationMs - nowMs;
			const refreshDelay = msUntilExpiry - 30_000; // We want to refresh 30s before official expiration
			const finalDelay = Math.max(0, refreshDelay); // In case the token is nearly or already expired, schedule immediately
			return setTimeout(() => {
				this.refreshTokens();
			}, finalDelay);

		} catch (error) {
			console.error('Error scheduling token refresh:', error);
			// If decoding fails, refresh immediately (?)
			return setTimeout(() => this.refreshTokens(), 0);
		}
	}

	async createSession(): Promise<CSAuthenticationSession> {
		try {
			const encodedTokenData = await this.login();
			if (!encodedTokenData) {
				throw new Error(`CodeStory login failure`);
			}

			const tokens = (await this.parseTokens(encodedTokenData));
			const session = await this.getSessionData(generateUuid(), tokens);
			this._onDidAuthenticate.fire(session);
			return session;
		} catch (e) {
			throw e;
		}
	}

	private async setSession(session: CSAuthenticationSession) {
		this._session = session;
		await this.secretStorageService.set(SESSION_SECRET_KEY, JSON.stringify(session));
	}

	async deleteSession(): Promise<void> {
		await this.secretStorageService.delete(SESSION_SECRET_KEY);
	}

	private async login() {
		const cts = new CancellationTokenSource();
		return await this.progressService.withProgress<string>(
			{
				location: ProgressLocation.Notification,
				title: 'Signing in to CodeStory...',
				cancellable: true,
			},
			async () => {
				const stateId = generateUuid();
				this._pendingStates.push(stateId);

				const url = `${this._websiteBase}/authenticate?state=${stateId}`;
				await this.openerService.open(url);

				try {
					const timeoutPromise = new Promise<string>((_, reject) =>
						setTimeout(() => reject('Cancelled'), 60000)
					);
					const cancellationPromise = new Promise<string>((_, reject) => {
						const cancellationListener = cts.token.onCancellationRequested(() => {
							cancellationListener.dispose();
							reject('User Cancelled');
						});
					});

					const loginPromise = new Promise<string>((resolve, reject) => {
						const disposable = this.urlService.registerHandler({
							handleURL: async (uri: URI): Promise<boolean> => {
								try {
									const tokenData = await this.handleUri(uri);
									resolve(tokenData);
									disposable.dispose();
									return true;
								} catch (e) {
									reject(e);
									return false;
								}
							},
						});
					});

					const pollingPromise = new Promise<string>((resolve, reject) => {
						let isPolling = true;

						// Handle cancellation for polling
						cts.token.onCancellationRequested(() => {
							isPolling = false;
							reject('User Cancelled');
						});

						const poll = async () => {
							if (!isPolling) {
								return;
							}

							try {
								const response = await fetch(`${this._subscriptionsAPIBase}/v1/auth/editor/status?state=${stateId}`);
								if (response.ok) {
									const data = await response.json();
									if (data.access_token && data.refresh_token) {
										const encodedData = encodeBase64(
											VSBuffer.fromString(
												JSON.stringify({
													access_token: data.access_token,
													refresh_token: data.refresh_token
												})
											)
										);
										resolve(encodedData);
										return;
									}
								}

								if (isPolling) {
									setTimeout(poll, 1000);
								}
							} catch (error) {
								if (isPolling) {
									setTimeout(poll, 1000);
								}
							}
						};
						poll();
					});

					const result = await Promise.race([
						loginPromise,
						pollingPromise,
						timeoutPromise,
						cancellationPromise
					]);

					return result;
				} finally {
					this._pendingStates = this._pendingStates.filter(n => n !== stateId);
				}
			},
			() => cts.cancel()
		);
	}

	private async handleUri(uri: URI): Promise<string> {
		const query = new URLSearchParams(uri.query);
		const encodedData = query.get('data');
		if (!encodedData) {
			return '';
		}

		return encodedData;
	}

	async getSession(options: GetSessionOptions): Promise<CSAuthenticationSession | undefined> {
		const { hardCheck } = options;

		if (hardCheck) {
			await this.refreshTokens();
		}

		const rawSession = await this.secretStorageService.get(SESSION_SECRET_KEY);
		const session: CSAuthenticationSession | undefined = rawSession ? JSON.parse(rawSession) : undefined;
		if (!session) {
			return undefined;
		} else if (session.account) {
			return session;
		}

		const currentTokens: EncodedCSTokenData = {
			access_token: session.accessToken,
			refresh_token: session.refreshToken,
		};

		try {
			const sessionData = await this.getSessionData(session.id, currentTokens);
			return sessionData;
		} catch (e) {
			if (e instanceof CSAuthenticationError) {
				await this.refreshTokens();
				const rawSession = await this.secretStorageService.get(SESSION_SECRET_KEY);
				return rawSession ? JSON.parse(rawSession) : undefined;
			}

			return undefined;
		}
	}

	private async parseTokens(encodedTokenData: string) {
		// Reverse the base64 encoding
		const tokenData = decodeBase64(encodedTokenData);
		const tokens = JSON.parse(tokenData.toString()) as EncodedCSTokenData;
		return tokens;
	}

	private async getSessionData(
		sessionId: string,
		tokens: EncodedCSTokenData
	): Promise<CSAuthenticationSession> {
		try {
			const [userResponse, subscriptionResponse] = await Promise.all([
				fetch(
					`${this._subscriptionsAPIBase}/v1/users/me`,
					{
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${tokens.access_token}`,
						},
					},
				),
				fetch(
					`${this._subscriptionsAPIBase}/v1/subscriptions`,
					{
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${tokens.access_token}`,
						},
					},
				),
			]);

			if (userResponse.status === 401 || subscriptionResponse.status === 401) {
				throw new CSAuthenticationError('Authentication token expired or invalid');
			}

			if (!userResponse.ok || !subscriptionResponse.ok) {
				throw new Error('Failed to fetch user data');
			}

			const userProfile = await userResponse.json() as CSUserProfileResponse;
			const subscriptionData = await subscriptionResponse.json() as SubscriptionResponse;

			const session: CSAuthenticationSession = {
				id: sessionId,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				account: userProfile.user,
				waitlistPosition: userProfile.waitlistPosition,
				subscription: subscriptionData,
			};

			await this.setSession(session);
			return session;
		} catch (e) {
			if (e instanceof CSAuthenticationError) {
				throw e;
			}

			throw new Error('Failed to fetch user data');
		}
	}
}


function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeJwtPayload(token: string): Record<string, any> {
	const [, payloadPart] = token.split('.');
	if (!payloadPart) {
		throw new Error('Invalid JWT format');
	}
	const base64Payload = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
	const decodedJson = decodeBase64(base64Payload).toString();
	return JSON.parse(decodedJson);
}


registerSingleton(ICSAuthenticationService, CSAuthenticationService, InstantiationType.Eager);
