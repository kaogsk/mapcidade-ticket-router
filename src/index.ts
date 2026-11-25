import express from "express";
import { loadConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile();
const config = loadConfig();
const router = await buildContainer(config);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/tickets", async (_req, res) => {
  res.json(await router.helpdesk.listTickets({}));
});

app.post("/api/tickets/:id/preview", async (req, res) => {
  const ticket = await router.helpdesk.getTicket(req.params.id);
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }
  res.json(await router.processor.preview(ticket));
});

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`Ticket Router listening on http://127.0.0.1:${config.port}`);
  if (config.poller.enabled) router.poller.start();
});

function shutdown() {
  server.close(() => void router.close());
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
