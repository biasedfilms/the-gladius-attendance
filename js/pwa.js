if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      // The core app remains usable if PWA registration is blocked by the host.
      console.warn("PWA registration was not available.", error);
    });
  });
}
