import { expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContainer } from "../src/container.js";

test("previews a seeded ticket without writing to the helpdesk", async () => {
  const router = await buildContainer(loadConfig({ ROUTER_DB_PATH: ":memory:" }));
  try {
    const tickets = await router.helpdesk.listTickets({});
    expect(tickets).toHaveLength(3);
    const ticket = await router.helpdesk.getTicket("101");
    if (!ticket) throw new Error("Missing demo ticket");
    const preview = await router.processor.preview(ticket);
    expect(preview.result.kind).toBe("classified");
    expect(router.fakeHelpdesk?.writes).toEqual([]);
  } finally {
    await router.close();
  }
});
