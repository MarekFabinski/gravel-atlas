const BASE = 'https://www.strava.com/api/v3/push_subscriptions';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const creds = () => ({
  client_id: env('STRAVA_CLIENT_ID'),
  client_secret: env('STRAVA_CLIENT_SECRET'),
});

async function view(): Promise<{ id: number; callback_url: string }[]> {
  const qs = new URLSearchParams(creds());
  const res = await fetch(`${BASE}?${qs}`);
  if (!res.ok) throw new Error(`view failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function create() {
  const body = new URLSearchParams({
    ...creds(),
    callback_url: `${env('APP_URL')}/api/strava/webhook`,
    verify_token: env('STRAVA_VERIFY_TOKEN'),
  });
  const res = await fetch(BASE, { method: 'POST', body });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  console.log('subscription created:', await res.json());
}

async function del() {
  const subs = await view();
  if (!subs.length) { console.log('no subscription to delete'); return; }
  for (const sub of subs) {
    const qs = new URLSearchParams(creds());
    const res = await fetch(`${BASE}/${sub.id}?${qs}`, { method: 'DELETE' });
    if (res.status !== 204) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
    console.log(`subscription ${sub.id} deleted`);
  }
}

const command = process.argv[2];
const run = command === 'create' ? create
  : command === 'view' ? () => view().then((s) => console.log(s.length ? s : 'no subscription'))
  : command === 'delete' ? del
  : null;

if (!run) {
  console.error('usage: strava-webhook.ts <create|view|delete>');
  process.exit(1);
}
run().catch((e) => { console.error(e); process.exit(1); });
