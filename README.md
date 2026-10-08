# Cellular Legends

Biologie-RPG gebaseerd op het aangeleverde spel, met 24 stages, vier klassen,
crafting en routes. De game staat in `index.html`; er is geen build of installatie nodig.

## Lokaal spelen

```sh
cd /workspace/cellular-legends
python3 -m http.server 8000 --bind 0.0.0.0
```

Open het spel via je eigen lokale ontwikkelomgeving op poort 8000.
De cloud-onboarding ondersteunt geen openbare previewlinks.

## Inventory, quests en market

- Inventory toont materialen, alle gemaakte/gekochte armors, focus en energie-items.
  Je kunt uitrusting aantrekken en afdoen.
- Solo begint met 40 munten. Vijanden geven 10 × regioniveau munten;
  bosses geven 35 × regioniveau. De risicoroute verdubbelt dit.
- Vier quests geven claimbare munten, materialen en herstelitems. Een beloning
  kan maar één keer per campagne worden geclaimd.
- Market verkoopt materialen, levelgebonden uitrusting en HP/ATP-items.
  De market is toegankelijk tijdens rustpauzes; elke derde route bevat een
  marketstop die 25 bonusmunten geeft.
- Herstelitems herstellen 40% van je maximale HP of ATP tijdens rustpauzes.
- Solo wordt automatisch opgeslagen in localStorage, ook tijdens gevechten.
  Klik opnieuw op Solo om te hervatten. Nieuwe expeditie wist na bevestiging
  de huidige solo-voortgang. Een nieuwe campagne reset ook inventory en munten.
  Saves zijn gebonden aan deze browser en de oorsprong van de website.

## Multiplayer

De aangeleverde HTML gebruikt de bestaande externe squadservice op
`cellular-legends-squad-michael.michaelvanderleeden.chatgpt.site`.
Deze repository bevat geen backend van die service. De bestaande squadflow is
behouden; de inventory toont de door die server verstrekte materialen en gear.
De nieuwe munten, quests, koopacties en verbruiksitems zijn voor solo.
Voor dezelfde mogelijkheden in squads moet de externe server worden bijgewerkt
met de spelregels in deze HTML. De beschikbaarheid van die service is niet
gegarandeerd door deze repository. Lettertypen worden opgehaald bij Google Fonts;
de overige spelcode is in de HTML opgenomen.

## Tests

Node.js 24 (geen npm-dependencies):

```sh
node --test tests/*.test.cjs
```

De tests gebruiken de daadwerkelijke spelregels uit index.html en controleren
transacties, questvoorwaarden, eenmalige beloningen, crafting, equipment,
verbruiksitems, combatbeperkingen en migratie/opslaan.
