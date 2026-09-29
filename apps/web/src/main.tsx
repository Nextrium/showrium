import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./lib";
import "./styles.css";

// showrium.com serves the website; product pages live on app.showrium.com.
const { hostname, pathname, search } = window.location;
if (hostname === "showrium.com" && (pathname === "/app" || pathname.startsWith("/app/") || pathname === "/signin" || pathname === "/invite")) {
  window.location.replace(`https://app.showrium.com${pathname}${search}`);
} else if (hostname === "app.showrium.com" && pathname === "/") {
  window.history.replaceState(null, "", "/app");
}

// Before the first paint, so the page never flashes the wrong theme.
applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
