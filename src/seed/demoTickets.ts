import { FakeHelpdesk } from "../helpdesk/fakeHelpdesk.js";

export function demoTickets() {
  const helpdesk = new FakeHelpdesk();
  return [
    helpdesk.createTicket({
      id: "101",
      subject: "Rivermeadow: mobile map does not sync",
      body: "The field survey is saved locally but is still waiting to sync.",
    }),
    helpdesk.createTicket({
      id: "102",
      subject: "Lakeside: business permit form is unavailable",
      body: "The permit form returns an error when submitted.",
    }),
    helpdesk.createTicket({
      id: "103",
      subject: "Oakwood: add a filter to the GIS layer list",
      body: "Please add a filter that groups layers by department.",
    }),
  ];
}
