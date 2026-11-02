import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppStateProvider } from "@/components/AppState";
import Shell from "@/components/Shell";
import PwaRegister from "@/components/PwaRegister";

export const metadata: Metadata = {
  applicationName: "Camera D-AI",
  title: "Camera D-AI — Nhìn, Ghi nhớ, Phân tích, Trả lời",
  description: "Trợ lý camera AI: xem camera, nhận diện, đếm, ghi nhớ, trích xuất ảnh và hỏi đáp tiếng Việt có bằng chứng.",
};

export const viewport: Viewport = {
  themeColor: "#080f1e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="text-slate-100 antialiased">
        <AppStateProvider>
          <PwaRegister />
          <Shell>{children}</Shell>
        </AppStateProvider>
      </body>
    </html>
  );
}
