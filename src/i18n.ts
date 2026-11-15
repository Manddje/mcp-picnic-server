import type { Request } from "express";

export type Lang = "en" | "nl" | "de" | "fr";
export const LANGS: Lang[] = ["en", "nl", "de", "fr"];
export const LANG_NAMES: Record<Lang, string> = { en: "English", nl: "Nederlands", de: "Deutsch", fr: "Français" };

const en = {
  // Landing page
  tagline: "Grocery shopping with your AI assistant",
  intro:
    "Connect Claude, ChatGPT or any other MCP app to your Picnic account. Search products, fill your cart, plan recipes and pick a delivery slot, just by asking.",
  // Shown under the title in search results, which cut it off after about 160 characters.
  metaDescription:
    "Connect Claude, ChatGPT or any other MCP app to your Picnic account. Search products, fill your cart, plan recipes and pick a delivery slot, just by asking.",
  urlLabel: "Server URL",
  copy: "Copy",
  copied: "Copied",
  howTitle: "Add it to your app",
  signinNote:
    "The first time you connect, a sign-in page opens. Enter your Picnic email and password, and the code Picnic texts you. That's it.",
  claudeTitle: "Claude (web, desktop and mobile)",
  claudeSteps: [
    "Open Settings → Connectors.",
    "Choose “Add custom connector”, give it a name (for example Picnic) and paste the server URL.",
    "Click Connect and sign in with your Picnic account.",
  ],
  claudeCodeTitle: "Claude Code",
  claudeCodeAfter: "Then type /mcp in Claude Code and pick picnic to sign in.",
  chatgptTitle: "ChatGPT",
  chatgptSteps: [
    "Open Settings → Apps & Connectors and turn on Developer mode under Advanced settings.",
    "Choose Create, paste the server URL and select OAuth as authentication.",
    "Sign in with your Picnic account and enable the connector in a chat.",
  ],
  cursorTitle: "Cursor",
  cursorButton: "Add to Cursor",
  cursorManual: "Or add this to ~/.cursor/mcp.json:",
  vscodeTitle: "VS Code (GitHub Copilot)",
  vscodeButton: "Add to VS Code",
  vscodeManual: "Or run this in a terminal:",
  otherTitle: "Other apps",
  otherText:
    "Every app that supports remote MCP servers (Streamable HTTP with OAuth) works: paste the server URL. For apps that only run local servers, use mcp-remote:",
  askTitle: "Things to ask",
  examples: [
    "“Put the ingredients for lasagne for four in my Picnic cart.”",
    "“What's on offer this week? Suggest three dinners with it.”",
    "“When can my groceries be delivered? Pick the first evening slot.”",
    "“Is there a cheaper alternative for the coffee in my cart?”",
  ],
  privacyTitle: "Privacy and safety",
  privacyItems: [
    "Your password is passed on to Picnic once to sign you in. It is never stored or logged.",
    "This server has no database. Your sign-in lives in an encrypted token that only your AI app holds.",
    "Your assistant can fill your cart and choose a delivery slot, but it cannot place or pay for an order. Checking out stays in the Picnic app.",
    "Disconnect at any time: remove the connector in your app, or ask your assistant to “disconnect my Picnic account”.",
  ],
  disclaimer: "Unofficial service. Not affiliated with, or endorsed by, Picnic.",
  contact: "Contact",
  source: "Source code",

  // Sign-in
  loginTitle: "Sign in with Picnic",
  loginFor: "{app} wants to connect to your Picnic account.",
  loginReturn: "After signing in you go back to {target}.",
  thisComputer: "an app on this computer",
  unknownApp:
    "This app is not on this server's list of known apps. Only continue if you just added Picnic yourself in an app at {target}. If someone sent you this link, close this page.",
  canDo: "It will be able to search products, view and change your cart, recipes and delivery slot, and see your orders.",
  cannotDo: "It cannot place or pay for an order.",
  country: "Country",
  countryNL: "Netherlands",
  countryDE: "Germany",
  countryFR: "France",
  email: "Email address",
  password: "Password",
  signIn: "Sign in",
  loginNote: "Your password is sent to Picnic only to sign you in. It is not stored.",
  errMissing: "Enter your email address and password.",
  errCredentials: "That email address and password don't match. Try again.",
  errThrottled: "Picnic is refusing sign-ins right now. Wait a few minutes and try again.",
  errGeneric: "Signing in at Picnic failed. Try again in a moment.",
  errTooMany: "Too many attempts. Wait a few minutes and try again.",
  errBusy: "Too many people are signing in right now. Wait a minute and try again.",
  expiredTitle: "This sign-in page has expired",
  expiredText: "Go back to your AI app and connect again.",

  // Verification code
  verifyTitle: "Check your phone",
  verifyText: "Picnic sent you a verification code by SMS. Enter it to finish signing in.",
  code: "Verification code",
  verify: "Verify",
  resend: "Send a new code",
  resent: "A new code is on its way.",
  errCode: "That code isn't right. Check the SMS and try again.",
  errCodeMissing: "Enter the code from the SMS.",
};

export type Strings = typeof en;

const nl: Strings = {
  tagline: "Boodschappen doen met je AI-assistent",
  intro:
    "Koppel Claude, ChatGPT of een andere MCP-app aan je Picnic-account. Zoek producten, vul je mandje, plan recepten en kies een bezorgmoment, gewoon door het te vragen.",
  metaDescription:
    "Koppel Claude, ChatGPT of een andere MCP-app aan je Picnic-account. Zoek producten, vul je mandje en kies een bezorgmoment, gewoon door het te vragen.",
  urlLabel: "Server-URL",
  copy: "Kopieer",
  copied: "Gekopieerd",
  howTitle: "Voeg toe aan je app",
  signinNote:
    "De eerste keer opent er een inlogpagina. Vul je Picnic-e-mailadres en wachtwoord in, en de code die Picnic je sms't. Meer is het niet.",
  claudeTitle: "Claude (web, desktop en mobiel)",
  claudeSteps: [
    "Open Instellingen → Connectors.",
    "Kies “Aangepaste connector toevoegen”, geef een naam (bijvoorbeeld Picnic) en plak de server-URL.",
    "Klik op Verbinden en log in met je Picnic-account.",
  ],
  claudeCodeTitle: "Claude Code",
  claudeCodeAfter: "Typ daarna /mcp in Claude Code en kies picnic om in te loggen.",
  chatgptTitle: "ChatGPT",
  chatgptSteps: [
    "Open Instellingen → Apps & Connectors en zet Developer mode aan onder Geavanceerde instellingen.",
    "Kies Create, plak de server-URL en selecteer OAuth als authenticatie.",
    "Log in met je Picnic-account en zet de connector aan in een chat.",
  ],
  cursorTitle: "Cursor",
  cursorButton: "Toevoegen aan Cursor",
  cursorManual: "Of zet dit in ~/.cursor/mcp.json:",
  vscodeTitle: "VS Code (GitHub Copilot)",
  vscodeButton: "Toevoegen aan VS Code",
  vscodeManual: "Of voer dit uit in een terminal:",
  otherTitle: "Andere apps",
  otherText:
    "Elke app die remote MCP-servers ondersteunt (Streamable HTTP met OAuth) werkt: plak de server-URL. Voor apps die alleen lokale servers draaien gebruik je mcp-remote:",
  askTitle: "Wat je kunt vragen",
  examples: [
    "“Zet de ingrediënten voor lasagne voor vier personen in mijn Picnic-mandje.”",
    "“Wat is er deze week in de aanbieding? Bedenk er drie avondmaaltijden mee.”",
    "“Wanneer kunnen mijn boodschappen bezorgd worden? Kies het eerste moment in de avond.”",
    "“Is er een goedkoper alternatief voor de koffie in mijn mandje?”",
  ],
  privacyTitle: "Privacy en veiligheid",
  privacyItems: [
    "Je wachtwoord wordt één keer doorgegeven aan Picnic om je in te loggen. Het wordt nooit opgeslagen of gelogd.",
    "Deze server heeft geen database. Je login zit in een versleuteld token dat alleen jouw AI-app bewaart.",
    "Je assistent kan je mandje vullen en een bezorgmoment kiezen, maar kan geen bestelling plaatsen of betalen. Afrekenen doe je zelf in de Picnic-app.",
    "Ontkoppelen kan altijd: verwijder de connector in je app, of vraag je assistent “ontkoppel mijn Picnic-account”.",
  ],
  disclaimer: "Onofficiële dienst. Niet verbonden aan of goedgekeurd door Picnic.",
  contact: "Contact",
  source: "Broncode",

  loginTitle: "Inloggen met Picnic",
  loginFor: "{app} wil verbinden met je Picnic-account.",
  loginReturn: "Na het inloggen ga je terug naar {target}.",
  thisComputer: "een app op deze computer",
  unknownApp:
    "Deze app staat niet op de lijst met bekende apps van deze server. Ga alleen verder als je Picnic net zelf hebt toegevoegd in een app op {target}. Heeft iemand je deze link gestuurd? Sluit dan deze pagina.",
  canDo: "De app kan producten zoeken, je mandje, recepten en bezorgmoment bekijken en aanpassen, en je bestellingen inzien.",
  cannotDo: "Een bestelling plaatsen of betalen kan de app niet.",
  country: "Land",
  countryNL: "Nederland",
  countryDE: "Duitsland",
  countryFR: "Frankrijk",
  email: "E-mailadres",
  password: "Wachtwoord",
  signIn: "Inloggen",
  loginNote: "Je wachtwoord gaat alleen naar Picnic om je in te loggen. Het wordt niet opgeslagen.",
  errMissing: "Vul je e-mailadres en wachtwoord in.",
  errCredentials: "Dit e-mailadres en wachtwoord horen niet bij elkaar. Probeer het opnieuw.",
  errThrottled: "Picnic weigert op dit moment inlogpogingen. Wacht een paar minuten en probeer het opnieuw.",
  errGeneric: "Inloggen bij Picnic is niet gelukt. Probeer het zo nog eens.",
  errTooMany: "Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.",
  errBusy: "Er loggen nu te veel mensen tegelijk in. Wacht een minuut en probeer het opnieuw.",
  expiredTitle: "Deze inlogpagina is verlopen",
  expiredText: "Ga terug naar je AI-app en verbind opnieuw.",

  verifyTitle: "Kijk op je telefoon",
  verifyText: "Picnic heeft je een verificatiecode ge-sms't. Vul die in om het inloggen af te ronden.",
  code: "Verificatiecode",
  verify: "Controleren",
  resend: "Stuur een nieuwe code",
  resent: "Er is een nieuwe code onderweg.",
  errCode: "Die code klopt niet. Controleer de sms en probeer het opnieuw.",
  errCodeMissing: "Vul de code uit de sms in.",
};

const de: Strings = {
  tagline: "Einkaufen mit deinem KI-Assistenten",
  intro:
    "Verbinde Claude, ChatGPT oder eine andere MCP-App mit deinem Picnic-Konto. Produkte suchen, Warenkorb füllen, Rezepte planen und ein Lieferfenster wählen, einfach per Frage.",
  metaDescription:
    "Verbinde Claude, ChatGPT oder eine andere MCP-App mit deinem Picnic-Konto. Produkte suchen, Warenkorb füllen und Lieferfenster wählen, einfach per Frage.",
  urlLabel: "Server-URL",
  copy: "Kopieren",
  copied: "Kopiert",
  howTitle: "Zu deiner App hinzufügen",
  signinNote:
    "Beim ersten Verbinden öffnet sich eine Anmeldeseite. Gib deine Picnic-E-Mail-Adresse, dein Passwort und den Code ein, den Picnic dir per SMS schickt. Das war's.",
  claudeTitle: "Claude (Web, Desktop und Mobil)",
  claudeSteps: [
    "Öffne Einstellungen → Connectors.",
    "Wähle „Benutzerdefinierten Connector hinzufügen“, vergib einen Namen (zum Beispiel Picnic) und füge die Server-URL ein.",
    "Klicke auf Verbinden und melde dich mit deinem Picnic-Konto an.",
  ],
  claudeCodeTitle: "Claude Code",
  claudeCodeAfter: "Gib danach /mcp in Claude Code ein und wähle picnic, um dich anzumelden.",
  chatgptTitle: "ChatGPT",
  chatgptSteps: [
    "Öffne Einstellungen → Apps & Connectors und aktiviere den Developer mode unter Erweiterte Einstellungen.",
    "Wähle Create, füge die Server-URL ein und wähle OAuth als Authentifizierung.",
    "Melde dich mit deinem Picnic-Konto an und aktiviere den Connector in einem Chat.",
  ],
  cursorTitle: "Cursor",
  cursorButton: "Zu Cursor hinzufügen",
  cursorManual: "Oder füge dies in ~/.cursor/mcp.json ein:",
  vscodeTitle: "VS Code (GitHub Copilot)",
  vscodeButton: "Zu VS Code hinzufügen",
  vscodeManual: "Oder führe dies im Terminal aus:",
  otherTitle: "Andere Apps",
  otherText:
    "Jede App, die Remote-MCP-Server unterstützt (Streamable HTTP mit OAuth), funktioniert: füge die Server-URL ein. Für Apps, die nur lokale Server starten, nutze mcp-remote:",
  askTitle: "Was du fragen kannst",
  examples: [
    "„Lege die Zutaten für Lasagne für vier Personen in meinen Picnic-Warenkorb.“",
    "„Was ist diese Woche im Angebot? Schlage drei Abendessen damit vor.“",
    "„Wann können meine Einkäufe geliefert werden? Wähle das erste Fenster am Abend.“",
    "„Gibt es eine günstigere Alternative für den Kaffee in meinem Warenkorb?“",
  ],
  privacyTitle: "Datenschutz und Sicherheit",
  privacyItems: [
    "Dein Passwort wird einmal an Picnic weitergegeben, um dich anzumelden. Es wird nie gespeichert oder protokolliert.",
    "Dieser Server hat keine Datenbank. Deine Anmeldung steckt in einem verschlüsselten Token, das nur deine KI-App aufbewahrt.",
    "Dein Assistent kann den Warenkorb füllen und ein Lieferfenster wählen, aber keine Bestellung aufgeben oder bezahlen. Das Bestellen bleibt in der Picnic-App.",
    "Trennen geht jederzeit: Entferne den Connector in deiner App oder bitte deinen Assistenten: „Trenne mein Picnic-Konto“.",
  ],
  disclaimer: "Inoffizieller Dienst. Nicht mit Picnic verbunden oder von Picnic unterstützt.",
  contact: "Kontakt",
  source: "Quellcode",

  loginTitle: "Mit Picnic anmelden",
  loginFor: "{app} möchte sich mit deinem Picnic-Konto verbinden.",
  loginReturn: "Nach der Anmeldung gelangst du zurück zu {target}.",
  thisComputer: "einer App auf diesem Computer",
  unknownApp:
    "Diese App steht nicht auf der Liste bekannter Apps dieses Servers. Fahre nur fort, wenn du Picnic gerade selbst in einer App unter {target} hinzugefügt hast. Hat dir jemand diesen Link geschickt? Dann schließe diese Seite.",
  canDo: "Die App kann Produkte suchen, Warenkorb, Rezepte und Lieferfenster ansehen und ändern sowie deine Bestellungen einsehen.",
  cannotDo: "Eine Bestellung aufgeben oder bezahlen kann sie nicht.",
  country: "Land",
  countryNL: "Niederlande",
  countryDE: "Deutschland",
  countryFR: "Frankreich",
  email: "E-Mail-Adresse",
  password: "Passwort",
  signIn: "Anmelden",
  loginNote: "Dein Passwort wird nur zur Anmeldung an Picnic gesendet. Es wird nicht gespeichert.",
  errMissing: "Gib deine E-Mail-Adresse und dein Passwort ein.",
  errCredentials: "E-Mail-Adresse und Passwort passen nicht zusammen. Versuche es erneut.",
  errThrottled: "Picnic lehnt Anmeldungen gerade ab. Warte ein paar Minuten und versuche es erneut.",
  errGeneric: "Die Anmeldung bei Picnic ist fehlgeschlagen. Versuche es gleich noch einmal.",
  errTooMany: "Zu viele Versuche. Warte ein paar Minuten und versuche es erneut.",
  errBusy: "Gerade melden sich zu viele Personen gleichzeitig an. Warte eine Minute und versuche es erneut.",
  expiredTitle: "Diese Anmeldeseite ist abgelaufen",
  expiredText: "Gehe zurück zu deiner KI-App und verbinde dich erneut.",

  verifyTitle: "Schau auf dein Handy",
  verifyText: "Picnic hat dir einen Bestätigungscode per SMS geschickt. Gib ihn ein, um die Anmeldung abzuschließen.",
  code: "Bestätigungscode",
  verify: "Bestätigen",
  resend: "Neuen Code senden",
  resent: "Ein neuer Code ist unterwegs.",
  errCode: "Der Code stimmt nicht. Prüfe die SMS und versuche es erneut.",
  errCodeMissing: "Gib den Code aus der SMS ein.",
};

const fr: Strings = {
  tagline: "Faites vos courses avec votre assistant IA",
  intro:
    "Connectez Claude, ChatGPT ou toute autre application MCP à votre compte Picnic. Cherchez des produits, remplissez votre panier, planifiez des recettes et choisissez un créneau de livraison, simplement en le demandant.",
  metaDescription:
    "Connectez Claude, ChatGPT ou une autre application MCP à votre compte Picnic. Cherchez des produits, remplissez votre panier et choisissez un créneau.",
  urlLabel: "URL du serveur",
  copy: "Copier",
  copied: "Copié",
  howTitle: "Ajoutez-le à votre application",
  signinNote:
    "À la première connexion, une page de connexion s'ouvre. Saisissez votre adresse e-mail et votre mot de passe Picnic, puis le code que Picnic vous envoie par SMS. C'est tout.",
  claudeTitle: "Claude (web, bureau et mobile)",
  claudeSteps: [
    "Ouvrez Paramètres → Connecteurs.",
    "Choisissez « Ajouter un connecteur personnalisé », donnez-lui un nom (par exemple Picnic) et collez l'URL du serveur.",
    "Cliquez sur Connecter et connectez-vous avec votre compte Picnic.",
  ],
  claudeCodeTitle: "Claude Code",
  claudeCodeAfter: "Tapez ensuite /mcp dans Claude Code et choisissez picnic pour vous connecter.",
  chatgptTitle: "ChatGPT",
  chatgptSteps: [
    "Ouvrez Paramètres → Apps & Connectors et activez le Developer mode dans les paramètres avancés.",
    "Choisissez Create, collez l'URL du serveur et sélectionnez OAuth comme authentification.",
    "Connectez-vous avec votre compte Picnic et activez le connecteur dans une conversation.",
  ],
  cursorTitle: "Cursor",
  cursorButton: "Ajouter à Cursor",
  cursorManual: "Ou ajoutez ceci à ~/.cursor/mcp.json :",
  vscodeTitle: "VS Code (GitHub Copilot)",
  vscodeButton: "Ajouter à VS Code",
  vscodeManual: "Ou exécutez ceci dans un terminal :",
  otherTitle: "Autres applications",
  otherText:
    "Toute application compatible avec les serveurs MCP distants (Streamable HTTP avec OAuth) fonctionne : collez l'URL du serveur. Pour les applications qui ne lancent que des serveurs locaux, utilisez mcp-remote :",
  askTitle: "Idées de demandes",
  examples: [
    "« Mets les ingrédients d'une lasagne pour quatre dans mon panier Picnic. »",
    "« Qu'est-ce qui est en promotion cette semaine ? Propose trois dîners avec. »",
    "« Quand mes courses peuvent-elles être livrées ? Choisis le premier créneau du soir. »",
    "« Existe-t-il une alternative moins chère au café de mon panier ? »",
  ],
  privacyTitle: "Confidentialité et sécurité",
  privacyItems: [
    "Votre mot de passe est transmis une seule fois à Picnic pour vous connecter. Il n'est jamais stocké ni journalisé.",
    "Ce serveur n'a pas de base de données. Votre connexion se trouve dans un jeton chiffré que seule votre application IA conserve.",
    "Votre assistant peut remplir votre panier et choisir un créneau, mais il ne peut ni passer ni payer une commande. La validation se fait dans l'application Picnic.",
    "Déconnectez-vous à tout moment : supprimez le connecteur dans votre application, ou demandez à votre assistant « déconnecte mon compte Picnic ».",
  ],
  disclaimer: "Service non officiel. Ni affilié à Picnic, ni approuvé par Picnic.",
  contact: "Contact",
  source: "Code source",

  loginTitle: "Se connecter avec Picnic",
  loginFor: "{app} souhaite se connecter à votre compte Picnic.",
  loginReturn: "Après la connexion, vous retournerez vers {target}.",
  thisComputer: "une application sur cet ordinateur",
  unknownApp:
    "Cette application ne figure pas dans la liste des applications connues de ce serveur. Ne continuez que si vous venez vous-même d'ajouter Picnic dans une application sur {target}. Si quelqu'un vous a envoyé ce lien, fermez cette page.",
  canDo: "L'application pourra chercher des produits, consulter et modifier votre panier, vos recettes et votre créneau de livraison, et voir vos commandes.",
  cannotDo: "Elle ne peut ni passer ni payer une commande.",
  country: "Pays",
  countryNL: "Pays-Bas",
  countryDE: "Allemagne",
  countryFR: "France",
  email: "Adresse e-mail",
  password: "Mot de passe",
  signIn: "Se connecter",
  loginNote: "Votre mot de passe est envoyé à Picnic uniquement pour vous connecter. Il n'est pas stocké.",
  errMissing: "Saisissez votre adresse e-mail et votre mot de passe.",
  errCredentials: "Cette adresse e-mail et ce mot de passe ne correspondent pas. Réessayez.",
  errThrottled: "Picnic refuse les connexions pour le moment. Patientez quelques minutes puis réessayez.",
  errGeneric: "La connexion à Picnic a échoué. Réessayez dans un instant.",
  errTooMany: "Trop de tentatives. Patientez quelques minutes puis réessayez.",
  errBusy: "Trop de personnes se connectent en ce moment. Patientez une minute puis réessayez.",
  expiredTitle: "Cette page de connexion a expiré",
  expiredText: "Retournez dans votre application IA et reconnectez-vous.",

  verifyTitle: "Regardez votre téléphone",
  verifyText: "Picnic vous a envoyé un code de vérification par SMS. Saisissez-le pour terminer la connexion.",
  code: "Code de vérification",
  verify: "Vérifier",
  resend: "Envoyer un nouveau code",
  resent: "Un nouveau code est en route.",
  errCode: "Ce code n'est pas correct. Vérifiez le SMS et réessayez.",
  errCodeMissing: "Saisissez le code reçu par SMS.",
};

export const STRINGS: Record<Lang, Strings> = { en, nl, de, fr };

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as string[]).includes(value);
}

/** The language asked for with `lang` (form field or query), else the browser's first supported one. */
export function pickLang(req: Request): Lang {
  const explicit = (req.body as Record<string, unknown> | undefined)?.lang ?? req.query.lang;
  if (isLang(explicit)) return explicit;
  const preferred = req.acceptsLanguages(LANGS);
  return isLang(preferred) ? preferred : "en";
}
