export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { error } = await searchParams;
  return (
    <main style={{ maxWidth: 320, margin: '20vh auto', fontFamily: 'system-ui' }}>
      <h1>🚵 Gravel Atlas</h1>
      <form method="post" action="/api/login">
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        />
        <button type="submit" style={{ width: '100%', padding: 8 }}>Enter</button>
        {error && (
          <p style={{ color: '#c0392b', fontSize: 13, marginTop: 8 }}>Wrong password</p>
        )}
      </form>
    </main>
  );
}
