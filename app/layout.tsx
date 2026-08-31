import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'StockSimple',
  description: 'Simple stock and inventory capture with review before approval.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>
}