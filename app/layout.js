export const metadata = {
  title: "Gurmeet Motors - Collections",
};
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#14532d" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/vendor/bootstrap.min.css" />
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
