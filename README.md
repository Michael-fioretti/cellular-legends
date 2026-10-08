# Cellular Legends

Biologie-RPG met 24 stages, vier klassen, inventory, quests, crafting en een
market. De repository bevat nu zowel het spel als een eigen multiplayerserver.
Solo en squads gebruiken dezelfde spelregels; de oude externe server is niet
meer nodig.

## Online spelen via Render

1. Log in op [Render](https://dashboard.render.com/).
2. Kies **New → Blueprint**, verbind GitHub en selecteer
   `Michael-fioretti/cellular-legends`. Je repository mag privé blijven;
   geef Render toegang tot deze repository.
3. Render leest `render.yaml`. Controleer dat het gratis plan is geselecteerd
   en klik **Deploy Blueprint** (of **Apply**).
4. Wacht tot de service **Live** is. Open de `onrender.com`-link van de service.
   Maak een squad, kies een klasse en genereer de invite link voor je vrienden.
   Iedereen kiest een andere klasse en klikt op **Ik ben gereed**; de host start.

Het spel en de API draaien samen op Render. Je hoeft geen serveradres, API-key,
losse database of aangepaste Netlify-instellingen in te voeren. Een losse
Netlify Drop van de HTML biedt alleen solo; gebruik voor multiplayer de
Render-speellink. De oude uitnodigingslinks werken niet op de nieuwe server.

### Opslag op het gratis plan

De server bewaart squads in SQLite. Bij herstart met dezelfde datamap blijven
squads, inventory, gevechten en sessies behouden; dat wordt door tests gecontroleerd.
**Render Free heeft geen blijvende disk. Bij slapen/herstarten/opnieuw deployen
kan de datamap verdwijnen en raken squads hun voortgang kwijt.** Render Free
is daarom vooral geschikt om samen te testen. De eerste verbinding na slapen
kan langer duren; probeer dan opnieuw wanneer de site geladen is.

Wil je squadvoortgang blijven bewaren op Render, kies dan een betaald plan
waarop een persistent disk beschikbaar is, voeg een disk met mount path `/data`
toe en wijzig `DATA_DIR` naar `/data`. Controleer vooraf de kosten in Render.
Gebruik één serverinstantie voor deze SQLite-opzet. Er wordt geen betaald plan
automatisch aangezet door de meegeleverde configuratie.

## Lokaal starten

Benodigd: Node.js 24. Geen externe npm-dependencies of build nodig.

```sh
npm ci --ignore-scripts
npm test
npm start
```

De server luistert standaard op poort 3000 en levert zowel `/` als de squad-API.
`PORT` wijzigt de poort; `DATA_DIR` bepaalt waar de SQLite-database wordt bewaard
(standaard `.data/`, niet in Git). De readinesscheck is `GET /api/health`.
De cloud-onboarding biedt geen openbare localhost-previewlinks.

Met Docker Compose kun je lokaal een blijvende datavolume gebruiken:

```sh
docker compose up --build
```

De Dockerconfiguratie is een alternatieve installatie; de uitgevoerde tests
gebruiken de Node-server rechtstreeks.

## Inventory, quests en market

- Iedere speler heeft eigen materialen, armor, focus, energie-items en munten.
  Uitgeruste items zijn zichtbaar en kunnen worden aangetrokken of afgedaan.
- Een campagne begint met 40 munten. Vijanden geven 10 × regioniveau munten;
  bosses geven 35 × regioniveau. De risicoroute verdubbelt dit.
- Vier quests geven claimbare munten, materialen en herstelitems. Een beloning
  kan iedere speler maar één keer per campagne claimen.
- Market verkoopt materialen, levelgebonden uitrusting en HP/ATP-items.
  De market is toegankelijk tijdens rustpauzes; elke derde route bevat een
  marketstop die 25 bonusmunten geeft.
- Herstelitems herstellen 40% van je maximale HP of ATP tijdens rustpauzes.
- Solo wordt opgeslagen in localStorage van jouw browser. Klik opnieuw op Solo
  om te hervatten. Nieuwe expeditie wist na bevestiging de huidige voortgang.
  Een nieuwe campagne reset inventory en munten.
- Squadvoortgang wordt op de server opgeslagen. Herladen van hetzelfde tabblad
  hervat je sessie; expliciet Verlaten beëindigt jouw deelname. Bewaar het tabblad
  als je wilt terugkeren. De hostrol gaat naar een overgebleven speler als de
  host vertrekt. Squads worden na 30 dagen inactiviteit opgeruimd.

## Moves en cooldowns

Een geslaagde move kost de volledige ATP-prijs, doet het normale effect en
blokkeert die move gedurende de volgende volledige rondes in de initiative:
1 ronde bij moves tot 25 ATP, 2 rondes bij moves van 26–40 ATP, 3 rondes bij
moves boven 40 ATP. Andere moves en basisaanvallen blijven beschikbaar.
Een fout antwoord of verlopen vraag kost dezelfde ATP-prijs en doet geen
schade/healing/effect van die move. In plaats daarvan krijgt alleen de speler
Membraan Schild: de eerstvolgende vijandelijke aanval doet 50% minder schade,
waarna het schild verdwijnt. De mislukte move krijgt geen cooldown.
De bestaande ATP-regeneratie na een beurt blijft actief. Cooldowns blijven
bewaard bij herladen en worden gewist aan het begin van een nieuw gevecht.
Dit werkt zowel in solo als in multiplayer.

## Hoe de server werkt

`game-rules.cjs` laadt de gedeelde spelregels uit `index.html`; dezelfde
`SquadEngine` voert solo en multiplayer uit. `server.cjs` controleert deelname,
inventory, munten, levels, cooldowns en de actieve beurt. De server kiest de
quizvraag en berekent wijzigingen. Alle spelers ontvangen dezelfde squadstate
via polling. Vijandbeurten lopen ook wanneer niemand een actie verstuurt.

Spelers krijgen willekeurige sessietokens; alleen hashes worden opgeslagen.
Invites verlopen na zeven dagen. Herhaalde netwerkrequests hebben een uniek
requestId en worden niet dubbel uitgevoerd; deze herhaalgegevens blijven zeven
dagen bewaard. De server serveert alleen de HTML;
broncode en database zijn niet via de website bereikbaar. Dit is een oefenspel:
de antwoorden staan ook in de biologievragen in de HTML, dus het is geen
competitief systeem dat spelers verhindert antwoorden vooraf te lezen.

## Tests

```sh
npm test
```

De tests oefenen de daadwerkelijke spelregels en HTTP-API: aankopen, quests,
crafting, equipment, mana, shields, cooldowns, samenwerken, invites, onbevoegde
acties, herhaalde requests, opslag en hervatten na een serverherstart.
Lettertypen worden opgehaald bij Google Fonts; overige spelcode zit in de HTML.
