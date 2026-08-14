import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Snowtrace",
    description: "A confidence-first AI snowboard progression coach.",
    openGraph: {
      title: "Snowtrace — See the gap. Ride the fix.",
      description: "Reference comparison with evidence you can see and drills you can ride.",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1731, height: 909, alt: "Snowtrace snowboard progression coach" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Snowtrace — See the gap. Ride the fix.",
      description: "Reference comparison with evidence you can see and drills you can ride.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
