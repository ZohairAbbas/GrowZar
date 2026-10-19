/**
 * What Growzar tells merchants about Ask and OpenAI (B3, B4; OpenAI's terms as
 * read on 2026-10-19). One text, shown in Settings → Ask and under the Ask box.
 */
export const ASK_PRIVACY = {
  short: "Questions and the store figures used to answer them are sent to OpenAI. Buyer names, phones, emails and addresses never are.",
  long: [
    "To answer a question, Growzar sends it to OpenAI, with the figures Growzar looks up for the answer: totals, rates and counts by product, city, courier or campaign. OpenAI processes them for Growzar.",
    "Buyer names, phone numbers, email addresses and addresses are never sent.",
    "Under OpenAI's API terms, what Growzar sends is not used to train OpenAI's models, and OpenAI keeps it for up to 30 days for abuse monitoring. Growzar asks OpenAI not to store the conversation.",
    "Growzar keeps your questions and answers for 90 days, then deletes their text; usage and your thumbs up or down stay.",
  ],
};
