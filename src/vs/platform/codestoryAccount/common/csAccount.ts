/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface CSAuthenticationSession {
	id: string;
	accessToken: string;
	refreshToken: string;
	account: CSUser;
	waitlistPosition: number;
	subscription: SubscriptionResponse;
}

export type CSUser = {
	id: string;
	first_name: string;
	last_name: string;
	email: string;
	created_at: string;
	updated_at: string;
	email_verified: boolean;
	profile_picture_url: string;
};

export type EncodedCSTokenData = {
	access_token: string;
	refresh_token: string;
};

export type CSUserProfileResponse = {
	user: CSUser;
	waitlistPosition: number;
};

export type SubscriptionStatus =
	| 'free'
	| 'pending_activation'
	| 'active'
	| 'pending_cancellation'
	| 'cancelled';
type InvoiceStatus =
	| 'active'
	| 'canceled'
	| 'incomplete'
	| 'incomplete_expired'
	| 'past_due'
	| 'paused'
	| 'trialing'
	| 'unpaid';
export type CurrentUsage = {
	freeUsage: number;
	overageUsage: number;
	estimatedUsage: number;
	breakdown: Record<string, number>;
};
export type SubscriptionResponse = {
	status: SubscriptionStatus;
	usage: CurrentUsage;
	invoiceStatus?: InvoiceStatus;
	subscriptionEnding?: number;
};

export type GetSessionOptions = {
	hardCheck: boolean;
};

export const statusAllowsAccess = (status: SubscriptionStatus): boolean => {
	return status === 'free' || status === 'active' || status === 'pending_cancellation';
};

export const ICSAccountService = createDecorator<ICSAccountService>('csAccountService');
export interface ICSAccountService {
	readonly _serviceBrand: undefined;

	toggle(): void;
	ensureAuthorized(): Promise<boolean>;
}

export const ICSAuthenticationService = createDecorator<ICSAuthenticationService>('csAuthenticationService');
export interface ICSAuthenticationService {
	readonly _serviceBrand: undefined;
	readonly onDidAuthenticate: Event<CSAuthenticationSession>;
	readonly onShouldAuthenticate: Event<void>;

	createSession(): Promise<CSAuthenticationSession>;
	deleteSession(sessionId: string): Promise<void>;
	refreshTokens(): Promise<void>;
	getSession(options: GetSessionOptions): Promise<CSAuthenticationSession | undefined>;
}
