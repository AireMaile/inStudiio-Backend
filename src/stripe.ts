import Stripe from 'stripe';
import { env } from './env.js';

// API version pinned to the SDK default for the installed stripe major.
// Not passing an override means we follow the SDK's pinned version, which is
// the recommended approach unless we need a specific API version.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY);
