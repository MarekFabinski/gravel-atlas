export default function LoginPage() {
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
      </form>
    </main>
  );
}
