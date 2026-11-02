import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Camera D-AI — Trợ lý camera AI",
    short_name: "Camera D-AI",
    description: "Trợ lý camera AI có trí nhớ: xem camera, ghi nhớ sự kiện, trích xuất ảnh và hỏi đáp tiếng Việt có bằng chứng.",
    start_url: "/",
    display: "standalone",
    background_color: "#080f1e",
    theme_color: "#080f1e",
    orientation: "any",
    lang: "vi",
    icons: [
      { src: "/icons/icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
