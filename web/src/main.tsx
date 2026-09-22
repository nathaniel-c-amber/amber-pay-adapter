import { createRoot } from "react-dom/client";
/* Variable faces: one file carries the whole 100–900 axis, so the UI can use
   intermediate weights (450/550) instead of only 400 and 700, and the browser
   downloads less than the four static Plex cuts it replaced. */
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/styles/tailwind.css";
import Shell from "@/components/Shell";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Shell />);
}