import type { Metadata } from 'next';
import { Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Section 4: JetBrains Mono is the protagonist (terminal, data, refs).
// Inter Tight is prose and UI chrome only.
const jbMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jbmono',
  display: 'swap',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-intertight',
  display: 'swap',
});

export const metadata: Metadata = {
  // Placeholder origin until a deploy domain exists (DECISIONS.md, Phase 8).
  metadataBase: new URL('https://gitsy.dev'),
  title: {
    default: 'Gitsy: learn Git by playing it',
    template: '%s · Gitsy',
  },
  description:
    'A browser game that takes you from total beginner to Git expert. Real Git engine, real terminal, zero installs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${jbMono.variable} ${interTight.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
