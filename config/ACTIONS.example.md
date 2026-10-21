# Actions

Rules for things to do when I send certain messages. Copy this file to config/ACTIONS.md, edit it, and set
ACTIONS_ENABLED=true in .env. Only my own sent messages trigger these.

## Confirmed meetings go on my calendar

When I confirm a specific date and time to meet, call, or visit someone (not when I only propose or ask about one),
create an event in my Google Calendar:

- Title: a short description with the other person's name, e.g. "Lunch with Maki".
- The confirmed date, time and place. 1 hour if no length was agreed.
- My calendar's time zone, unless another one was stated.
- Look up the other person's email in my contacts and add them as a guest only if exactly one contact matches.
  Don't send invitations.
