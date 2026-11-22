# TicketCard

One ticket in "Your tickets". Shows priority, category, review marker, title, description (2 lines), status, ID and date.

Props: `ticket` `{ id, priority, category, status, date, title, description, review?, reviewReason? }`. Categories: plumbing, electrical, heating, appliance, structural, pest, other.

- Emergency tickets get a `border-edge` top edge in `priority-emergency` — and nothing louder.
- A ticket in human review shows ReviewBadge **and** a plain reason ("Quote is over £500, so a person at the agency is approving it").
