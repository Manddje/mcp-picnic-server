import type { Lang } from "../i18n.js";

const en = {
  // Sign-in
  loginTitle: "Connect Albert Heijn",
  loginFor: "{app} wants to connect to your Albert Heijn account.",
  loginReturn: "Afterwards you go back to {target}.",
  unknownApp:
    "This app is not on this server's list of known apps. Only continue if you just added Albert Heijn yourself in an app at {target}. If someone sent you this link, close this page.",
  step1Title: "1. Sign in at Albert Heijn",
  step1Text: "Albert Heijn's own sign-in page opens in a new tab. This server never sees your password.",
  step1Button: "Open Albert Heijn's sign-in page",
  step2Title: "2. Paste the address you end up at",
  step2Text:
    "After signing in, Albert Heijn sends your browser to an address that starts with appie://login-exit?code=. That address is meant for its app, so your browser shows nothing new. Copy it and paste it here.",
  howTitle: "Where do I find that address?",
  howSteps: [
    "Do this on a computer, in Chrome, Edge or Firefox.",
    "Click the button above. In the tab that opens, press F12 and choose the Network tab, before you sign in.",
    "Sign in. At the end the page seems to stop loading; that is expected.",
    "In the Network list, find the line whose address starts with appie://login-exit. Right-click it, choose Copy, then Copy URL.",
    "No such line? Look through the last lines of the list for one whose Response Headers have a Location that starts with appie://login-exit, and copy that value.",
  ],
  pasteLabel: "Address or code",
  connect: "Connect",
  guestTitle: "No account, or no luck with the address?",
  guestText: "Searching products, bonus deals, recipes and delivery times works without signing in. Your basket and orders do not.",
  guestButton: "Continue without signing in",
  canDo: "It will be able to search products and recipes, see bonus deals and delivery times, view and fill your basket, and see your orders.",
  cannotDo: "It cannot book a delivery, place an order or pay.",
  loginNote: "The code works once and only for a short time. It is not stored.",
  errMissing: "Paste the address that starts with appie://login-exit, or the code from it.",
  errCode: "Albert Heijn does not accept that code. A code works once and only briefly: sign in at Albert Heijn again and paste the new address.",
  errThrottled: "Albert Heijn is refusing sign-ins right now. Wait a few minutes and try again.",
  errRefused: "Albert Heijn refuses requests from this server right now. Try again later.",
  errGeneric: "Signing in at Albert Heijn failed. Try again in a moment.",
  disclaimer: "Unofficial service. Not affiliated with, or endorsed by, Albert Heijn.",

  // Landing page
  landingTitle: "Albert Heijn too",
  landingText:
    "This server has a second connector, for Albert Heijn (Netherlands). Add this address as a connector of its own to search products, bonus deals and recipes and to fill your basket. Booking a delivery and paying stay in the Albert Heijn app.",
  landingUrlLabel: "Server URL for Albert Heijn",
  landingSignin: "Signing in works differently here: you sign in on Albert Heijn's own page and paste the address it ends at. The sign-in page shows how.",
};

export type AhStrings = typeof en;

const nl: AhStrings = {
  loginTitle: "Albert Heijn koppelen",
  loginFor: "{app} wil verbinden met je Albert Heijn-account.",
  loginReturn: "Daarna ga je terug naar {target}.",
  unknownApp:
    "Deze app staat niet op de lijst met bekende apps van deze server. Ga alleen verder als je Albert Heijn net zelf hebt toegevoegd in een app op {target}. Heeft iemand je deze link gestuurd? Sluit dan deze pagina.",
  step1Title: "1. Log in bij Albert Heijn",
  step1Text: "De inlogpagina van Albert Heijn zelf opent in een nieuw tabblad. Deze server ziet je wachtwoord nooit.",
  step1Button: "Open de inlogpagina van Albert Heijn",
  step2Title: "2. Plak het adres waar je uitkomt",
  step2Text:
    "Na het inloggen stuurt Albert Heijn je browser naar een adres dat begint met appie://login-exit?code=. Dat adres is bedoeld voor de app, dus je browser laat niets nieuws zien. Kopieer het en plak het hier.",
  howTitle: "Waar vind ik dat adres?",
  howSteps: [
    "Doe dit op een computer, in Chrome, Edge of Firefox.",
    "Klik op de knop hierboven. Druk in het tabblad dat opent op F12 en kies het tabblad Network (Netwerk), vóór je inlogt.",
    "Log in. Aan het eind lijkt de pagina te blijven hangen; dat hoort zo.",
    "Zoek in de lijst onder Network de regel waarvan het adres begint met appie://login-exit. Klik er met rechts op, kies Copy en dan Copy URL.",
    "Staat die regel er niet? Zoek dan bij de laatste regels van de lijst er een met onder Response Headers een Location die begint met appie://login-exit, en kopieer die waarde.",
  ],
  pasteLabel: "Adres of code",
  connect: "Koppelen",
  guestTitle: "Geen account, of lukt het adres niet?",
  guestText: "Producten zoeken, bonusaanbiedingen, recepten en bezorgmomenten werken zonder inloggen. Je mandje en bestellingen niet.",
  guestButton: "Verder zonder inloggen",
  canDo: "De app kan producten en recepten zoeken, bonusaanbiedingen en bezorgmomenten bekijken, je mandje bekijken en vullen, en je bestellingen inzien.",
  cannotDo: "Een bezorgmoment boeken, een bestelling plaatsen of betalen kan de app niet.",
  loginNote: "De code werkt één keer en maar kort. Hij wordt niet opgeslagen.",
  errMissing: "Plak het adres dat begint met appie://login-exit, of de code daaruit.",
  errCode: "Albert Heijn accepteert die code niet. Een code werkt één keer en maar kort: log opnieuw in bij Albert Heijn en plak het nieuwe adres.",
  errThrottled: "Albert Heijn weigert op dit moment inlogpogingen. Wacht een paar minuten en probeer het opnieuw.",
  errRefused: "Albert Heijn weigert op dit moment verzoeken van deze server. Probeer het later opnieuw.",
  errGeneric: "Inloggen bij Albert Heijn is niet gelukt. Probeer het zo nog eens.",
  disclaimer: "Onofficiële dienst. Niet verbonden aan of goedgekeurd door Albert Heijn.",

  landingTitle: "Ook Albert Heijn",
  landingText:
    "Deze server heeft een tweede connector, voor Albert Heijn. Voeg dit adres toe als eigen connector om producten, bonusaanbiedingen en recepten te zoeken en je mandje te vullen. Een bezorgmoment boeken en betalen doe je in de Albert Heijn-app.",
  landingUrlLabel: "Server-URL voor Albert Heijn",
  landingSignin: "Inloggen gaat hier anders: je logt in op de pagina van Albert Heijn zelf en plakt het adres waar die eindigt. De inlogpagina legt uit hoe.",
};

/** Albert Heijn is a Dutch shop: its pages are in Dutch and English, and other languages get English. */
export const AH_STRINGS: Record<Lang, AhStrings> = { en, nl, de: en, fr: en };
