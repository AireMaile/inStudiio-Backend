import { Router, type RequestHandler } from 'express';

const successPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Subscription confirmed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:10vh auto;padding:0 1rem;text-align:center;color:#111}h1{font-size:1.75rem}</style>
</head><body>
<h1>You're subscribed 🎉</h1>
<p>You can close this tab and return to the app.</p>
</body></html>
`;

const cancelPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Checkout canceled</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:10vh auto;padding:0 1rem;text-align:center;color:#111}h1{font-size:1.75rem}</style>
</head><body>
<h1>Checkout canceled</h1>
<p>No charge was made. You can close this tab and try again from the app.</p>
</body></html>
`;

export function createSubscribePagesRouter(): Router {
  const router = Router();
  const success: RequestHandler = (_req, res) => { res.status(200).type('html').send(successPage); };
  const cancel: RequestHandler = (_req, res) => { res.status(200).type('html').send(cancelPage); };
  router.get('/success', success);
  router.get('/cancel', cancel);
  return router;
}
