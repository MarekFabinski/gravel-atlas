const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpass(query: string): Promise<any> {
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass rejects requests without a descriptive User-Agent (406);
          // Node's fetch sends none by default.
          'User-Agent': 'gravel-atlas-import/1.0 (mafabinski@gmail.com)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`overpass ${url}: ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      console.warn(`overpass mirror failed, trying next: ${e}`);
    }
  }
  throw lastError;
}
