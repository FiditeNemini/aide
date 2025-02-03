/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	export interface AuthenticatedCSUser {
		email: string;
	}

	export type SubscriptionStatus =
		| 'free'
		| 'pending_activation'
		| 'active'
		| 'pending_cancellation'
		| 'cancelled';

	export interface SubscriptionResponse {
		status: SubscriptionStatus;
		subscriptionEnding?: number;
	}

	export interface CSAuthenticationSession {
		/**
		 * The access token.
		 */
		readonly accessToken: string;

		/**
		 * The authenticated user.
		 */
		readonly account: AuthenticatedCSUser;

		/**
		 * The subscription information.
		 */
		readonly subscription: SubscriptionResponse;
	}

	export namespace csAuthentication {
		export type GetSessionOptions = {
			hardCheck: boolean;
		};
		export function getSession(options: GetSessionOptions): Thenable<CSAuthenticationSession | undefined>;
		export function refreshSession(): Thenable<CSAuthenticationSession | undefined>;
	}
}
