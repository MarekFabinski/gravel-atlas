import type { Metadata } from 'next';
import Link from 'next/link';
import SyncButton from '@/components/SyncButton';
import './globals.css';

export const metadata: Metadata = { title: 'Gravel Atlas' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{
        margin: 0, fontFamily: 'system-ui',
        display: 'flex', flexDirection: 'column', minHeight: '100dvh',
      }}>
        <header style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, padding: '8px 16px',
          borderBottom: '1px solid #ddd',
        }}>
          <strong>🚵 Gravel Atlas</strong>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link href="/">Map</Link>
            <Link href="/character">Character</Link>
            <Link href="/rides">Rides</Link>
          </nav>
          <span style={{ marginLeft: 'auto' }}><SyncButton /></span>
        </header>
        {children}
      </body>
    </html>
  );
}
