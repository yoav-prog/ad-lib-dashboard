import './globals.css';

export const metadata = {
  title: 'ADINTEL - Command Center',
  description: 'Competitive ad intelligence',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
