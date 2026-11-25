const select = document.querySelector("#ticket");
const preview = document.querySelector("#preview");
const status = document.querySelector("#status");
const result = document.querySelector("#result");

async function request(path, method = "GET") {
  const response = await fetch(path, { method });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

async function loadTickets() {
  try {
    const tickets = await request("/api/tickets");
    for (const ticket of tickets) {
      select.add(new Option(ticket.subject, ticket.id));
    }
    preview.disabled = tickets.length === 0;
  } catch (error) {
    status.textContent = error.message;
  }
}

preview.addEventListener("click", async () => {
  status.textContent = "Calculating…";
  result.textContent = "";
  try {
    const data = await request(`/api/tickets/${encodeURIComponent(select.value)}/preview`, "POST");
    result.textContent = JSON.stringify(data, null, 2);
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  }
});

loadTickets();
