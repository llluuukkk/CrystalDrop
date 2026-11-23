// CrystalDrop game rules, run on the server. Every game takes draw() (a number from 0 up to 1, from the provably fair stream)
// and returns the outcome, so the browser never decides a result. Money is in the server's ledger, not here.
'use strict';
const MAXPAY = 50000;
// generated from the site's tables, do not edit by hand
const PLT = {
      Low: { 8: [5.6, 2.1, 1.1, 1, 0.5], 9: [5.6, 2, 1.6, 1, 0.7], 10: [8.9, 3, 1.4, 1.1, 1, 0.5], 11: [8.4, 3, 1.9, 1.3, 1, 0.7], 12: [10, 3, 1.6, 1.4, 1.1, 1, 0.5], 13: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7], 14: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5], 15: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7], 16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5] },
      Medium: { 8: [13, 3, 1.3, 0.7, 0.4], 9: [18, 4, 1.7, 0.9, 0.5], 10: [22, 5, 2, 1.4, 0.6, 0.4], 11: [24, 6, 3, 1.8, 0.7, 0.5], 12: [33, 11, 4, 2, 1.1, 0.6, 0.3], 13: [43, 13, 6, 3, 1.3, 0.7, 0.4], 14: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2], 15: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3], 16: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3] },
      High: { 8: [29, 4, 1.5, 0.3, 0.2], 9: [43, 7, 2, 0.6, 0.2], 10: [76, 10, 3, 0.9, 0.3, 0.2], 11: [120, 14, 5.2, 1.4, 0.4, 0.2], 12: [170, 24, 8.1, 2, 0.7, 0.2, 0.2], 13: [260, 37, 11, 4, 1, 0.2, 0.2], 14: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2], 15: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2], 16: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2] } };
    
const KT = {
      Classic: [[0, 3.96], [0, 1.9, 4.5], [0, 1, 3.1, 10.4], [0, .8, 1.8, 5, 22.5], [0, .25, 1.4, 4.1, 16.5, 36], [0, 0, 1, 3.68, 7, 16.5, 40], [0, 0, .47, 3, 4.5, 14, 31, 60], [0, 0, 0, 2.2, 4, 13, 22, 55, 70], [0, 0, 0, 1.55, 3, 8, 15, 44, 60, 85], [0, 0, 0, 1.4, 2.25, 4.5, 8, 17, 50, 80, 100]],
      Low: [[.7, 1.85], [0, 2, 3.8], [0, 1.1, 1.38, 26], [0, 0, 2.2, 7.9, 90], [0, 0, 1.5, 4.2, 13, 300], [0, 0, 1.1, 2, 6.2, 100, 700], [0, 0, 1.1, 1.6, 3.5, 15, 225, 700], [0, 0, 1.1, 1.5, 2, 5.5, 39, 100, 800], [0, 0, 1.1, 1.3, 1.7, 2.5, 7.5, 50, 250, 1000], [0, 0, 1.1, 1.2, 1.3, 1.8, 3.5, 13, 50, 250, 1000]],
      Medium: [[.4, 2.75], [0, 1.8, 5.1], [0, 0, 2.8, 50], [0, 0, 1.7, 10, 100], [0, 0, 1.4, 4, 14, 390], [0, 0, 0, 3, 9, 180, 710], [0, 0, 0, 2, 7, 30, 400, 800], [0, 0, 0, 2, 4, 11, 67, 400, 900], [0, 0, 0, 2, 2.5, 5, 15, 100, 500, 1000], [0, 0, 0, 1.6, 2, 4, 7, 26, 100, 500, 1000]],
      High: [[0, 3.96], [0, 0, 17.1], [0, 0, 0, 81.5], [0, 0, 0, 10, 259], [0, 0, 0, 4.5, 48, 450], [0, 0, 0, 0, 11, 350, 710], [0, 0, 0, 0, 7, 90, 400, 800], [0, 0, 0, 0, 5, 20, 270, 600, 900], [0, 0, 0, 0, 4, 11, 56, 500, 800, 1000], [0, 0, 0, 0, 3.5, 8, 13, 63, 500, 800, 1000]],
      Extreme: [[0, 5.49], [0, 0, 33.54], [0, 0, 0, 226.4], [0, 0, 0, 0, 1714], [0, 0, 0, 0, 126.55, 10000], [0, 0, 0, 0, 35.4, 1900, 10000], [0, 0, 0, 0, 18.95, 450, 5000, 10000], [0, 0, 0, 0, 13.37, 180, 1000, 5000, 10000], [0, 0, 0, 0, 6.5, 90, 500, 2000, 5000, 10000], [0, 0, 0, 0, 3.28, 44, 300, 1500, 5000, 8000, 10000]] };
    
const UP_RAW = `pistol|0|P250|Sand Dune|FT|0.05
smg|0|MP9|Storm|FT|0.07
shotgun|0|Nova|Predator|FT|0.08
pistol|1|USP-S|Road Rash|FT|0.09
pistol|0|Tec-9|Groundwater|FT|0.11
shotgun|0|Sawed-Off|Forest DDPAT|FT|0.14
smg|0|MAC-10|Silver|FT|0.16
pistol|0|Five-SeveN|Forest Night|FT|0.2
rifle|0|Galil AR|Sage Spirit|FT|0.25
smg|1|UMP-45|Carbon Fiber|FT|0.3
smg|1|P90|Module|FT|0.35
rifle|0|FAMAS|Colony|FT|0.4
pistol|1|P2000|Granite Marbleized|FN|0.5
pistol|1|Glock-18|Candy Apple|FN|0.55
smg|1|MP7|Skulls|FT|0.6
shotgun|1|Nova|Walnut|FT|0.7
pistol|1|CZ75-Auto|Tuxedo|FT|0.9
rifle|1|SG 553|Anodized Navy|FN|1.1
sniper|0|AWP|Safari Mesh|FT|1.2
rifle|2|M4A4|Desert-Strike|FT|1.8
rifle|2|AK-47|Slate|FT|2.4
pistol|2|Glock-18|Water Elemental|FT|3.2
sniper|3|AWP|Atheris|FT|3.6
pistol|3|P250|Asiimov|FT|4.5
smg|3|P90|Asiimov|FT|5.5
rifle|3|M4A1-S|Guardian|FT|6.2
pistol|2|USP-S|Cortex|FT|6.8
pistol|4|Five-SeveN|Hyper Beast|FT|8
rifle|4|M4A1-S|Cyrex|FT|9.5
pistol|4|USP-S|Neo-Noir|FT|11
rifle|4|AK-47|Redline|FT|14
sniper|4|SSG 08|Blood in the Water|FT|20
rifle|5|M4A1-S|Hyper Beast|FT|24
sniper|5|AWP|Hyper Beast|FT|28
rifle|5|M4A4|Asiimov|FT|35
rifle|4|AK-47|Vulcan|FT|38
rifle|5|AK-47|Asiimov|FT|45
smg|4|MP9|Hot Rod|FN|55
pistol|5|USP-S|Kill Confirmed|FT|62
sniper|5|AWP|Asiimov|BS|70
sniper|5|AWP|Lightning Strike|FN|75
pistol|5|Desert Eagle|Printstream|FT|85
rifle|5|AK-47|Fire Serpent|FT|390
pistol|4|Desert Eagle|Blaze|FN|480
pistol|4|Glock-18|Fade|FN|900
rifle|5|AK-47|Fire Serpent|FN|1350
sniper|5|AWP|Dragon Lore|FT|3300
rifle|6|M4A4|Howl|FT|3800
rifle|6|M4A4|Howl|FN|6800
sniper|5|AWP|Gungnir|MW|9200
rifle|5|AK-47|Wild Lotus|FN|13500
sniper|5|AWP|Dragon Lore|FN|17500
sniper|5|StatTrak AWP|Dragon Lore|FN|47500
pistol|2|Glock-18|Flashback|FT|0.68
rifle|3|M4A4|Dragon Tech|FT|0.9
pistol|2|P250|Phoenix Blacklight|FT|0.7
rifle|2|AK-47|Phantom Disruptor|FT|0.72
smg|3|MP9|Deadly Poison|FT|0.85
smg|2|MAC-10|Heat|FT|4.9
smg|2|MP7|Cirrus|FT|1.4
smg|3|UMP-45|Exposure|FT|1.21
smg|1|P90|Scavenger|FT|1.2
smg|2|P90|Death by Kitty|FT|2.8
smg|2|PP-Bizon|Fuel Rod|FT|0.8
smg|2|MP5-SD|Phosphor|FT|1.1
smg|3|UMP-45|Primal Saber|FT|10.4
rifle|0|FAMAS|Sundown|FT|0.55
rifle|2|FAMAS|Neural Net|FT|3.7
rifle|3|FAMAS|Roll Cage|FT|4.2
rifle|2|Galil AR|Chromatic Aberration|FT|3.1
rifle|2|Galil AR|Eco|FT|12.4
rifle|3|Galil AR|Cerberus|FT|35
rifle|1|SG 553|Pulse|FT|0.7
rifle|3|SG 553|Cyrex|FT|9
rifle|2|AUG|Chameleon|FT|2.2
rifle|3|AUG|Bengal Tiger|FT|36
rifle|4|AUG|Akihabara Accept|FT|85
rifle|4|AK-47|Neon Revolution|FT|26
rifle|3|AK-47|Bloodsport|FT|28
rifle|2|AK-47|Elite Build|FT|8
rifle|2|AK-47|Blue Laminate|FT|5.5
rifle|4|AK-47|Hydroponic|FT|120
rifle|5|AK-47|Neon Rider|FT|55
rifle|5|AK-47|Gold Arabesque|FN|640
rifle|3|M4A4|Neo-Noir|FT|18
rifle|4|M4A4|Buzz Kill|FT|29
rifle|4|M4A4|The Emperor|FT|62
rifle|5|M4A4|Poseidon|FT|380
rifle|3|M4A1-S|Decimator|FT|27
rifle|3|M4A1-S|Printstream|FT|70
rifle|4|M4A1-S|Golden Coil|FT|38
rifle|5|M4A1-S|Knight|FN|1300
sniper|3|SSG 08|Dragonfire|FT|21
sniper|2|SSG 08|Abyss|FT|3.6
sniper|4|SSG 08|Death Strike|FT|5.5
sniper|3|SCAR-20|Cyrex|FT|8.5
sniper|4|SCAR-20|Bloodsport|FT|11
sniper|3|G3SG1|Flux|FT|19.9
sniper|5|AWP|Containment Breach|FT|75
sniper|5|AWP|Neo-Noir|FT|48
sniper|4|AWP|Redline|FT|28
sniper|5|AWP|Medusa|FT|2500
sniper|5|AWP|Fade|FN|4100
pistol|4|Desert Eagle|Code Red|FT|55
pistol|4|Desert Eagle|Kumicho Dragon|FT|22
pistol|4|Desert Eagle|Hypnotic|FN|36
pistol|3|Desert Eagle|Mecha Industries|FT|15.5
pistol|4|Glock-18|Vogue|FT|4.1
pistol|4|Glock-18|Neo-Noir|FT|18
pistol|3|Glock-18|Wasteland Rebel|FT|14
pistol|3|USP-S|Orion|FT|28
pistol|3|USP-S|Guardian|FT|6
pistol|4|USP-S|Printstream|FT|40
pistol|4|USP-S|Whiteout|FN|85
pistol|3|P250|Muertos|FT|4.6
pistol|3|P250|Nuclear Threat|FT|48
pistol|4|P250|See Ya Later|FT|6.9
pistol|4|P250|Supernova|FT|5.4
pistol|3|Tec-9|Fuel Injector|FT|6.8
pistol|4|Tec-9|Decimator|FT|36
pistol|3|CZ75-Auto|Victoria|FT|5.2
pistol|4|CZ75-Auto|Xiangliu|FT|20
pistol|3|R8 Revolver|Fade|FN|20
pistol|4|R8 Revolver|Llama Cannon|FT|27
pistol|3|Five-SeveN|Monkey Business|FT|12
pistol|3|Five-SeveN|Angry Mob|FT|4
pistol|2|P2000|Ocean Foam|FN|12
pistol|4|P2000|Fire Elemental|FT|20
pistol|3|Dual Berettas|Cobra Strike|FT|3.4
shotgun|3|Nova|Hyper Beast|FT|5.2
shotgun|3|XM1014|Tranquility|FT|10.4
shotgun|4|XM1014|Incinegator|FT|5
shotgun|3|MAG-7|Bulldozer|FT|4.4
shotgun|3|Sawed-Off|The Kraken|FT|6.7
lmg|3|M249|Nebula Crusader|FT|2.6
lmg|3|Negev|Power Loader|FT|3.1
lmg|4|M249|Emerald Poison Dart|FT|1.9
knife|6|★ Gut Knife|Safari Mesh|FT|30
knife|6|★ Gut Knife|Urban Masked|FT|36
knife|6|★ Gut Knife|Stained|FT|50
knife|6|★ Gut Knife|Black Laminate|FT|55
knife|6|★ Gut Knife|Crimson Web|FN|160
knife|6|★ Gut Knife|Tiger Tooth|FN|150
knife|6|★ Falchion Knife|Blue Steel|FT|69
knife|6|★ Falchion Knife|Case Hardened|FN|80.5
knife|6|★ Falchion Knife|Marble Fade|FN|230
knife|6|★ Falchion Knife|Ultraviolet|FN|138
knife|6|★ Falchion Knife|Vanilla|FN|218
knife|6|★ Falchion Knife|Forest DDPAT|FT|35.65
knife|6|★ Navaja Knife|Fade|FN|500
knife|6|★ Navaja Knife|Doppler|FN|170
knife|6|★ Navaja Knife|Safari Mesh|FT|30
knife|6|★ Navaja Knife|Urban Masked|FT|36
knife|6|★ Navaja Knife|Stained|FT|50
knife|6|★ Navaja Knife|Black Laminate|FT|55
knife|6|★ Bayonet|Boreal Forest|FT|56.1
knife|6|★ Bayonet|Scorched|FT|51
knife|6|★ Bayonet|Blue Steel|FT|102
knife|6|★ Bayonet|Case Hardened|FN|119
knife|6|★ Bayonet|Marble Fade|FN|340
knife|6|★ Bayonet|Ultraviolet|FN|204
knife|6|★ Flip Knife|Damascus Steel|FT|102
knife|6|★ Flip Knife|Slaughter|FN|165
knife|6|★ Flip Knife|Fade|FN|750
knife|6|★ Flip Knife|Doppler|FN|255
knife|6|★ Flip Knife|Safari Mesh|FT|45
knife|6|★ Flip Knife|Urban Masked|FT|54
knife|6|★ Huntsman Knife|Tiger Tooth|FN|240
knife|6|★ Huntsman Knife|Gamma Doppler|FN|416
knife|6|★ Huntsman Knife|Boreal Forest|FT|52.8
knife|6|★ Huntsman Knife|Scorched|FT|48
knife|6|★ Huntsman Knife|Blue Steel|FT|96
knife|6|★ Huntsman Knife|Case Hardened|FN|112
knife|6|★ Shadow Daggers|Forest DDPAT|FT|37.2
knife|6|★ Shadow Daggers|Night Stripe|FT|54
knife|6|★ Shadow Daggers|Damascus Steel|FT|81.6
knife|6|★ Shadow Daggers|Slaughter|FN|132
knife|6|★ Shadow Daggers|Fade|FN|600
knife|6|★ Shadow Daggers|Doppler|FN|204
knife|6|★ Bowie Knife|Black Laminate|FT|77
knife|6|★ Bowie Knife|Crimson Web|FN|224
knife|6|★ Bowie Knife|Tiger Tooth|FN|210
knife|6|★ Bowie Knife|Gamma Doppler|FN|364
knife|6|★ Bowie Knife|Boreal Forest|FT|46.2
knife|6|★ Bowie Knife|Scorched|FT|42
knife|6|★ M9 Bayonet|Ultraviolet|FN|264
knife|6|★ M9 Bayonet|Vanilla|FN|418
knife|6|★ M9 Bayonet|Forest DDPAT|FT|68.2
knife|6|★ M9 Bayonet|Night Stripe|FT|99
knife|6|★ M9 Bayonet|Damascus Steel|FT|150
knife|6|★ M9 Bayonet|Slaughter|FN|242
knife|6|★ Butterfly Knife|Urban Masked|FT|115
knife|6|★ Butterfly Knife|Stained|FT|160
knife|6|★ Butterfly Knife|Black Laminate|FT|176
knife|6|★ Butterfly Knife|Crimson Web|FN|512
knife|6|★ Butterfly Knife|Tiger Tooth|FN|480
knife|6|★ Butterfly Knife|Gamma Doppler|FN|832
knife|6|★ Karambit|Case Hardened|FN|245
knife|6|★ Karambit|Marble Fade|FN|700
knife|6|★ Karambit|Ultraviolet|FN|420
knife|6|★ Karambit|Vanilla|FN|665
knife|6|★ Karambit|Forest DDPAT|FT|108
knife|6|★ Karambit|Night Stripe|FT|158
knife|6|★ Talon Knife|Doppler|FN|578
knife|6|★ Talon Knife|Safari Mesh|FT|102
knife|6|★ Talon Knife|Urban Masked|FT|122
knife|6|★ Talon Knife|Stained|FT|170
knife|6|★ Talon Knife|Black Laminate|FT|187
knife|6|★ Talon Knife|Crimson Web|FN|544
knife|6|★ Stiletto Knife|Scorched|FT|54
knife|6|★ Stiletto Knife|Blue Steel|FT|108
knife|6|★ Stiletto Knife|Case Hardened|FN|126
knife|6|★ Stiletto Knife|Marble Fade|FN|360
knife|6|★ Stiletto Knife|Ultraviolet|FN|216
knife|6|★ Stiletto Knife|Vanilla|FN|342
knife|6|★ Ursus Knife|Slaughter|FN|187
knife|6|★ Ursus Knife|Fade|FN|850
knife|6|★ Ursus Knife|Doppler|FN|289
knife|6|★ Ursus Knife|Safari Mesh|FT|51
knife|6|★ Ursus Knife|Urban Masked|FT|61.2
knife|6|★ Ursus Knife|Stained|FT|85
knife|6|★ Nomad Knife|Gamma Doppler|FN|364
knife|6|★ Nomad Knife|Boreal Forest|FT|46.2
knife|6|★ Nomad Knife|Scorched|FT|42
knife|6|★ Nomad Knife|Blue Steel|FT|84
knife|6|★ Nomad Knife|Case Hardened|FN|98
knife|6|★ Nomad Knife|Marble Fade|FN|280
knife|6|★ Skeleton Knife|Night Stripe|FT|135
knife|6|★ Skeleton Knife|Damascus Steel|FT|204
knife|6|★ Skeleton Knife|Slaughter|FN|330
knife|6|★ Skeleton Knife|Fade|FN|1500
knife|6|★ Skeleton Knife|Doppler|FN|510
knife|6|★ Skeleton Knife|Safari Mesh|FT|90
knife|6|★ Survival Knife|Crimson Web|FN|208
knife|6|★ Survival Knife|Tiger Tooth|FN|195
knife|6|★ Survival Knife|Gamma Doppler|FN|338
knife|6|★ Survival Knife|Boreal Forest|FT|42.9
knife|6|★ Survival Knife|Scorched|FT|39
knife|6|★ Survival Knife|Blue Steel|FT|78
knife|6|★ Paracord Knife|Vanilla|FN|247
knife|6|★ Paracord Knife|Forest DDPAT|FT|40.3
knife|6|★ Paracord Knife|Night Stripe|FT|58.5
knife|6|★ Paracord Knife|Damascus Steel|FT|88.4
knife|6|★ Paracord Knife|Slaughter|FN|143
knife|6|★ Paracord Knife|Fade|FN|650
knife|6|★ Classic Knife|Stained|FT|100
knife|6|★ Classic Knife|Black Laminate|FT|110
knife|6|★ Classic Knife|Crimson Web|FN|320
knife|6|★ Classic Knife|Tiger Tooth|FN|300
knife|6|★ Classic Knife|Gamma Doppler|FN|520
knife|6|★ Classic Knife|Boreal Forest|FT|66
knife|6|★ Karambit|Doppler Phase 1|FN|730
knife|6|★ Karambit|Doppler Phase 3|FN|790
knife|6|★ Karambit|Doppler Ruby|FN|4400
knife|6|★ Karambit|Doppler Sapphire|FN|4800
knife|6|★ Karambit|Doppler Black Pearl|FN|3300
knife|6|★ Karambit|Case Hardened (Blue Gem)|FN|38000
knife|6|★ Butterfly Knife|Doppler Sapphire|FN|9100
gloves|6|Hand Wraps|Cobalt Skulls|FT|120
gloves|6|Hand Wraps|Slaughter|FT|230
gloves|6|Hand Wraps|Duct Tape|FT|55
gloves|6|Hand Wraps|Leather|FT|48
gloves|6|Bloodhound Gloves|Charred|FT|180
gloves|6|Bloodhound Gloves|Snakebite|FT|230
gloves|6|Bloodhound Gloves|Bronzed|FT|160
gloves|6|Broken Fang Gloves|Jade|FT|195
gloves|6|Broken Fang Gloves|Yellow-banded|FT|330
gloves|6|Moto Gloves|Spearmint|FT|250
gloves|6|Moto Gloves|Eclipse|FT|140
gloves|6|Moto Gloves|Cool Mint|FT|210
gloves|6|Moto Gloves|Polygon|FT|95
gloves|6|Driver Gloves|King Snake|FT|640
gloves|6|Driver Gloves|Crimson Weave|FT|720
gloves|6|Driver Gloves|Diamondback|FT|230
gloves|6|Specialist Gloves|Crimson Kimono|FT|720
gloves|6|Specialist Gloves|Emerald Web|FT|1250
gloves|6|Specialist Gloves|Fade|FT|1400
gloves|6|Specialist Gloves|Forest DDPAT|FT|120
gloves|6|Hydra Gloves|Case Hardened|FT|410
gloves|6|Hydra Gloves|Emerald|FT|480
gloves|6|Sport Gloves|Pandora\'s Box|FT|2700
gloves|6|Sport Gloves|Vice|FT|2300
gloves|6|Sport Gloves|Superconductor|FT|1950
gloves|6|Sport Gloves|Hedge Maze|FT|1850
gloves|6|Sport Gloves|Amphibious|FT|520
gloves|6|Sport Gloves|Arid|FT|130`;

const upMhn = (w, sk, wr) => { const EX = { FN: 'Factory New', MW: 'Minimal Wear', FT: 'Field-Tested', WW: 'Well-Worn', BS: 'Battle-Scarred' }; let star = '', st = '';
  if (w.startsWith('★ ')) { star = '★ '; w = w.slice(2); } if (w.startsWith('StatTrak ')) { st = 'StatTrak™ '; w = w.slice(9); }
  let b = sk.replace(/ ?\(.*\)$/, ''); if (/^Doppler (Phase|Ruby|Sapphire|Black)/.test(b)) b = 'Doppler'; if (b.startsWith('Case Hardened')) b = 'Case Hardened';
  return star + st + w + ' | ' + b + ' (' + EX[wr] + ')'; };
const upCat = UP_RAW.slice(UP_RAW.indexOf('`') + 1, UP_RAW.lastIndexOf('`')).split('\n').map(l => { const [type, g, w, sk, wear, pr] = l.split('|'); return { type, g: +g, name: w + ' | ' + sk + ' (' + wear + ')', price: +pr, base: +pr, mhn: upMhn(type === 'gloves' && !w.startsWith('★') ? '★ ' + w : w, sk, wear) }; })
  .sort((a, b) => a.price - b.price).map((x, i) => ({ ...x, id: i }));
const UPCAT = upCat;
const ri = (d, n) => Math.floor(d() * n);
const K = 0.98;   // house-edge factor: every payout (except Roulette and Blackjack) is scaled by this, so the edge is 2% of the stake bigger
const SU = '♠♥♦♣';
const err = m => { const e = new Error(m); e.user = true; return e; };
const isNum = x => typeof x === 'number' && isFinite(x);

// ---- cards ----
const mkShoe = () => ({ c: Array(52).fill(8), n: 416 });
const shoeDraw = (sh, d) => { let k = ri(d, sh.n), i = 0; while (k >= sh.c[i]) { k -= sh.c[i]; i++; } sh.c[i]--; sh.n--; return { r: 1 + (i >> 2), s: SU[i & 3] }; };
const isRed = c => c.s === '♥' || c.s === '♦';

// ---- Dice ----
const Dice = { lim: [0.01, 10000], bet(d, p) {
  const t = +p.t, over = !!p.over; if (!isNum(t)) throw err('bad target');
  const ch = over ? 100 - t : t; if (!(ch >= 0.0099 - 1e-9) || ch > 98 + 1e-9) throw err('Win chance must be 0.0099% to 98%');
  const m = Math.min(10000, 99 * K / ch), vi = ri(d, 1000000), v = vi / 10000, ti = Math.round(t * 10000), w = over ? vi >= ti : vi < ti;
  return { mult: w ? m : 0, view: { v, w }, label: 'Rolled ' + v.toFixed(2) }; } };

// ---- Limbo ----
const Limbo = { lim: [0.01, 10000], bet(d, p) {
  const T = Math.min(1e4, Math.max(1.01, +p.target || 1.01)), v = Math.min(1e4, Math.max(1, Math.floor(0.99 * K / d() * 100) / 100)), w = v >= T;
  return { mult: w ? T : 0, view: { v, w }, label: v.toFixed(2) + 'x' }; } };

// ---- Coin Flip ----
const Flip = { lim: [0.01, 10000], bet(d, p) {
  const pick = p.pick === 'T' ? 'T' : 'H', r = d() < .5 ? 'H' : 'T';
  return { mult: r === pick ? 1.96 * K : 0, view: { r }, label: r === 'H' ? 'Heads' : 'Tails' }; } };

// ---- Roulette ----
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RZ = (() => { const Z = {}, add = (k, nums, pay) => { Z[k] = { nums, pay }; }, num = (c, r) => 3 * (c + 1) - r, all = [...Array(36)].map((_, i) => i + 1);
  add('n0', [0], 35); for (let c = 0; c < 12; c++) for (let r = 0; r < 3; r++) { const n = num(c, r); add('n' + n, [n], 35); }
  [0, 1, 2].forEach(r => add('col' + r, all.filter(n => r === 0 ? n % 3 === 0 : r === 1 ? n % 3 === 2 : n % 3 === 1), 2));
  [0, 1, 2].forEach(i => add('doz' + i, all.filter(n => Math.ceil(n / 12) === i + 1), 2));
  [n => n <= 18, n => n % 2 === 0, n => RED.has(n), n => !RED.has(n), n => n % 2 === 1, n => n >= 19].forEach((f, i) => add('out' + i, all.filter(f), 1));
  for (let c = 0; c < 11; c++) for (let r = 0; r < 3; r++) add(`sh${c}_${r}`, [num(c, r), num(c + 1, r)], 17);
  for (let c = 0; c < 12; c++) for (let r = 0; r < 2; r++) add(`sv${c}_${r}`, [num(c, r), num(c, r + 1)], 17);
  for (let r = 0; r < 3; r++) add('z' + r, [0, 3 - r], 17);
  for (let c = 0; c < 11; c++) for (let r = 0; r < 2; r++) add(`cr${c}_${r}`, [num(c, r), num(c, r + 1), num(c + 1, r), num(c + 1, r + 1)], 8);
  for (let c = 0; c < 12; c++) add('st' + c, [3 * c + 1, 3 * c + 2, 3 * c + 3], 11);
  for (let c = 0; c < 11; c++) add('sx' + c, [3 * c + 1, 3 * c + 2, 3 * c + 3, 3 * c + 4, 3 * c + 5, 3 * c + 6], 5);
  add('t1', [0, 1, 2], 11); add('t2', [0, 2, 3], 11); add('f4', [0, 1, 2, 3], 8); return Z; })();
const cents = x => Math.round(x * 100) / 100;
const Roulette = { lim: [0.01, 5000], total(p) { const b = p.bets; if (!b || typeof b !== 'object') throw err('Place a chip first'); let t = 0; for (const k of Object.keys(b)) { if (!RZ[k]) throw err('bad amount'); const a = +b[k]; if (!(a > 0) || !isNum(a)) throw err('bad amount'); t += a; } return cents(t); },
  bet(d, p, stake) { const n = ri(d, 37); let P = 0; for (const k of Object.keys(p.bets)) if (RZ[k].nums.includes(n)) P += cents(+p.bets[k]) * (RZ[k].pay + 1);
    return { mult: cents(P) / stake, view: { n }, label: n + ' ' + (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black') }; } };

// ---- Plinko ----
const plTbl = (risk, R) => { const h = PLT[risk][R]; return h.concat((R % 2 === 0 ? h.slice(0, -1) : h).slice().reverse()).map(x => x >= 1000 ? x : x * K); };
const Plinko = { lim: [0.01, 1000], bet(d, p) {
  const risk = p.risk, R = +p.rows; if (!PLT[risk] || !PLT[risk][R]) throw err('bad plinko setup');
  const path = Array.from({ length: R }, () => d() < .5 ? -1 : 1), k = path.filter(x => x > 0).length, m = plTbl(risk, R)[k];
  return { mult: m, view: { path, k }, label: m.toFixed(2) + '×' }; } };

// ---- Keno ----
const Keno = { lim: [0.01, 10000], bet(d, p) {
  const risk = p.risk; if (!KT[risk]) throw err('bad risk'); const N = risk === 'Extreme' ? 56 : 40, pk = p.picks;
  if (!Array.isArray(pk) || !pk.length || pk.length > 10 || new Set(pk).size !== pk.length || pk.some(x => !Number.isInteger(x) || x < 0 || x >= N)) throw err('Pick 1 to 10 numbers');
  const dr = []; while (dr.length < 10) { const v = ri(d, N); if (!dr.includes(v)) dr.push(v); }
  const hits = pk.filter(x => dr.includes(x)).length;
  return { mult: (KT[risk][pk.length - 1][hits] || 0) * K, view: { draw: dr, hits }, label: hits + ' hits' }; } };

// ---- Baccarat ----
const bv = c => c.r >= 10 ? 0 : c.r, btot = a => a.reduce((x, c) => x + bv(c), 0) % 10;
const BSIDE = new Set(['PP', 'PB', 'PF', 'BP', 'BB', 'EP']), BKEYS = new Set(['P', 'T', 'B', ...BSIDE]);
const bonusRet = (h, o) => { const a = btot(h), c = btot(o), nat = h.length === 2 && a >= 8, onat = o.length === 2 && c >= 8; if (a === c) return nat && onat ? 1 : 0; if (a < c) return 0; if (nat) return 2; return ({ 4: 2, 5: 3, 6: 5, 7: 7, 8: 11, 9: 31 })[a - c] || 0; };
const bacRes = (P, B) => { const pt = btot(P), bt = btot(B), win = pt > bt ? 'P' : bt > pt ? 'B' : 'T', r = {};
  r.P = win === 'P' ? 2 : win === 'T' ? 1 : 0; r.B = win === 'B' ? 1.95 : win === 'T' ? 1 : 0; r.T = win === 'T' ? 9 : 0;
  const pp = P[0].r === P[1].r, bp = B[0].r === B[1].r; r.PP = pp ? 12 : 0; r.BP = bp ? 12 : 0; r.EP = pp || bp ? 6 : 0;
  r.PF = (pp && P[0].s === P[1].s) || (bp && B[0].s === B[1].s) ? 26 : 0; r.PB = bonusRet(P, B); r.BB = bonusRet(B, P); return { r, win }; };
const Baccarat = { lim: [0.01, 50000], total(p) { const b = p.bets; if (!b || typeof b !== 'object') throw err('Place a chip first'); let t = 0;
    for (const k of Object.keys(b)) { if (!BKEYS.has(k)) throw err('bad amount'); const a = +b[k]; if (!(a > 0) || !isNum(a)) throw err('bad amount'); if (BSIDE.has(k) && a > 3000) throw err('Max side upgrade is 3,000.00'); if (k === 'T' && a > 10000) throw err('Tie max upgrade is 10,000.00'); t += a; } return cents(t); },
  bet(d, p, stake) { const sh = mkShoe(), dc = () => shoeDraw(sh, d), P = [dc(), dc()], B = [dc(), dc()];
    if (btot(P) < 8 && btot(B) < 8) { let p3 = null; if (btot(P) <= 5) { p3 = dc(); P.push(p3); }
      const bb = btot(B), v = p3 && bv(p3);
      if (!p3 ? bb <= 5 : (bb <= 2 || (bb === 3 && v !== 8) || (bb === 4 && v >= 2 && v <= 7) || (bb === 5 && v >= 4 && v <= 7) || (bb === 6 && v >= 6 && v <= 7))) B.push(dc()); }
    const { r, win } = bacRes(P, B); let pay = 0; for (const k of Object.keys(p.bets)) pay += cents(+p.bets[k]) * r[k];
    return { mult: cents(pay) / stake, view: { P, B, win, r }, label: win === 'T' ? 'Tie' : (win === 'P' ? 'Player' : 'Banker') + ' wins' }; } };

// ---- Mines (hidden board kept on the server) ----
const mnMult = (N, n, k) => { let x = .96 * K; for (let i = 0; i < k; i++) x *= (N - i) / (N - n - i); return x; };
const mnSetup = p => { const side = +p.side, n = +p.mines; if (!Number.isInteger(side) || side < 5 || side > 8) throw err('bad board'); const N = side * side; if (!Number.isInteger(n) || n < 1 || n > N - 1) throw err('bad mine count'); return { side, N, n }; };
const mkMines = (d, N, n) => { const s = new Set(); while (s.size < n) s.add(ri(d, N)); return [...s]; };
const Mines = { lim: [0.01, 6000],
  start(d, p) { const { side, N, n } = mnSetup(p); return { st: { side, N, n, mines: mkMines(d, N, n), open: [] }, view: { open: [], N, n } }; },
  act(d, st, a) { if (!Number.isInteger(a.pick) || a.pick < 0 || a.pick >= st.N || st.open.includes(a.pick)) throw err('bad tile');
    if (st.mines.includes(a.pick)) { st.open.push(a.pick); return { done: true, mult: 0, label: 'Hit a mine', view: { open: st.open, mines: st.mines, hit: a.pick } }; }
    st.open.push(a.pick); if (st.open.length === st.N - st.n) return { done: true, mult: mnMult(st.N, st.n, st.open.length), label: 'Board cleared', view: { open: st.open, mines: st.mines } };
    return { view: { open: st.open } }; },
  cash(d, st) { if (!st.open.length) throw err('Open a tile first'); return { done: true, mult: mnMult(st.N, st.n, st.open.length), label: 'Cashed out', view: { open: st.open, mines: st.mines } }; },
  abandon(d, st, stake) { return st.open.length ? Mines.cash(d, st) : { done: true, mult: 1, label: 'Round cancelled', view: { open: [], mines: st.mines } }; },
  auto(d, p) { const { N, n } = mnSetup(p), pk = p.picks; if (!Array.isArray(pk) || !pk.length || pk.length > N - n || new Set(pk).size !== pk.length || pk.some(x => !Number.isInteger(x) || x < 0 || x >= N)) throw err('Select at least one tile');
    const ms = mkMines(d, N, n), hit = pk.findIndex(v => ms.includes(v)), K = pk.length;
    return { mult: hit < 0 ? mnMult(N, n, K) : 0, label: hit < 0 ? K + ' gems found' : 'Hit a mine', view: { mines: ms, open: hit < 0 ? pk : pk.slice(0, hit + 1) } }; } };

// ---- Hi-Lo ----
const HL_EDGE = .96 * K, hlStep = (c, hi, g) => (g ? 1 : HL_EDGE) / ((hi ? 14 - c : c) / 13);
const hlCard = d => ({ r: 1 + ri(d, 13), s: SU[ri(d, 4)] });
const HiLo = { lim: [0.01, 10000],
  start(d) { const c = hlCard(d); return { st: { cur: c, m: 1, sk: 0, g: 0 }, view: { cur: c, m: 1, sk: 0, g: 0 } }; },
  act(d, st, a, stake) { const c = st.cur, k = a.k; if (k !== 'hi' && k !== 'lo' && k !== 'skip') throw err('bad move'); if (k === 'skip' && st.sk >= 10) throw err('No skips left');
    const n = hlCard(d); st.cur = n;
    if (k === 'skip') { st.sk++; return { view: { cur: n, prev: c, m: st.m, sk: st.sk, k } }; }
    const ok = k === 'hi' ? n.r >= c.r : n.r <= c.r; if (!ok) { st.m = 0; return { done: true, mult: 0, label: 'Wrong guess', view: { cur: n, prev: c, m: 0, sk: st.sk, k, ok: false } }; }
    st.m = st.m * hlStep(c.r, k === 'hi', st.g); st.g++;
    if (stake * st.m >= MAXPAY) return { done: true, mult: MAXPAY / stake, label: 'Max payout', view: { cur: n, prev: c, m: st.m, sk: st.sk, k, ok: true, max: true } };
    return { view: { cur: n, prev: c, m: st.m, sk: st.sk, g: st.g, k, ok: true } }; },
  cash(d, st, stake) { return { done: true, mult: Math.min(st.m, MAXPAY / stake), label: 'Cashed out', view: { m: st.m } }; },
  abandon(d, st, stake) { return HiLo.cash(d, st, stake); } };

// ---- Tower ----
const TWD = [['Easy', 4, 1], ['Medium', 3, 1], ['Hard', 2, 1], ['Expert', 3, 2], ['Master', 4, 3]], TWR = 8;
const twM = (c, bd, k) => Math.min(1000000, +(0.96 * K * Math.pow(c / (c - bd), k)).toFixed(2));
const mkTower = (d, C, BD) => Array.from({ length: TWR }, () => { const s = new Set(); while (s.size < BD) s.add(ri(d, C)); return [...s]; });
const Tower = { lim: [0.01, 10000],
  start(d, p) { const di = +p.di; if (!Number.isInteger(di) || !TWD[di]) throw err('bad difficulty'); const [, C, BD] = TWD[di]; return { st: { di, C, BD, bad: mkTower(d, C, BD), row: 0, picks: [] }, view: { row: 0, C, BD } }; },
  act(d, st, a) { const j = a.pick; if (!Number.isInteger(j) || j < 0 || j >= st.C) throw err('bad tile'); const row = st.row; st.picks.push(j);
    if (st.bad[row].includes(j)) return { done: true, mult: 0, label: 'Hit a trap', view: { row, picks: st.picks, bad: st.bad, hit: true } };
    if (row === TWR - 1) { st.row = TWR; return { done: true, mult: twM(st.C, st.BD, TWR), label: 'Reached the top', view: { row: TWR, picks: st.picks, bad: st.bad } }; }
    st.row = row + 1; return { view: { row: st.row, picks: st.picks } }; },
  cash(d, st) { if (!st.row) throw err('Climb a floor first'); return { done: true, mult: twM(st.C, st.BD, st.row), label: 'Cashed out', view: { row: st.row, picks: st.picks, bad: st.bad } }; },
  abandon(d, st) { return st.row ? Tower.cash(d, st) : { done: true, mult: 1, label: 'Round cancelled', view: { row: 0, picks: [], bad: st.bad } }; },
  auto(d, p) { const di = +p.di; if (!TWD[di]) throw err('bad difficulty'); const [, C, BD] = TWD[di], path = p.path;
    if (!Array.isArray(path) || !path.length || path.length > TWR || path.some(j => !Number.isInteger(j) || j < 0 || j >= C)) throw err('Pick a path first');
    const bad = mkTower(d, C, BD), hit = path.findIndex((j, r) => bad[r].includes(j)), dead = hit >= 0, picks = dead ? path.slice(0, hit + 1) : path, K = path.length;
    return { mult: dead ? 0 : twM(C, BD, K), label: dead ? 'Hit a trap' : 'Climbed ' + K + ' floors', view: { bad, picks, row: picks.length, hit: dead } }; } };

// ---- Duck Cross (Chicken) ----
const CHD = [['Easy', 1, 24], ['Medium', 3, 22], ['Hard', 5, 20], ['Expert', 10, 15]];
const chM = (bd, k) => { let p = 1; for (let i = 0; i < k; i++) p *= (25 - bd - i) / (25 - i); return .96 * K / p; };
const Chicken = { lim: [0.01, 10000],
  start(d, p) { const di = +p.d; if (!CHD[di]) throw err('bad difficulty'); return { st: { di, k: 0 }, view: { k: 0 } }; },
  act(d, st) { const [, bd, SF] = CHD[st.di], i = st.k, safe = d() < (SF - i) / (25 - i);
    if (!safe) return { done: true, mult: 0, label: 'Hit by a car', view: { k: i, safe: false } };
    st.k = i + 1; if (st.k === SF) return { done: true, mult: chM(bd, st.k), label: 'Reached the other side', view: { k: st.k, safe: true, end: true } };
    return { view: { k: st.k, safe: true } }; },
  cash(d, st) { if (!st.k) throw err('Cross a lane first'); return { done: true, mult: chM(CHD[st.di][1], st.k), label: 'Cashed out', view: { k: st.k } }; },
  abandon(d, st) { return st.k ? Chicken.cash(d, st) : { done: true, mult: 1, label: 'Round cancelled', view: { k: 0 } }; },
  auto(d, p) { const di = +p.d; if (!CHD[di]) throw err('bad difficulty'); const [, bd, SF] = CHD[di], L = Math.min(Math.max(1, Math.floor(+p.lanes) || 1), SF); let k = 0; while (k < L && d() < (SF - k) / (25 - k)) k++;
    const ok = k === L; return { mult: ok ? chM(bd, L) : 0, label: ok ? 'Crossed ' + L + ' lanes' : 'Hit by a car', view: { k, dead: !ok } }; } };

// ---- War ----
const vv = c => c.r === 1 ? 14 : c.r;
const War = { lim: [0.01, 10000],
  start(d, p, stake) { const tv = cents(+p.tie || 0), cv = cents(+p.ctie || 0); if (tv < 0 || cv < 0 || (tv > 0 && tv < .01) || (cv > 0 && cv < .01) || tv > 10000 || cv > 10000) throw err('Side upgrades are 0.01 to 10,000.00');
    const sh = mkShoe(), P = shoeDraw(sh, d), D = shoeDraw(sh, d), tie = vv(P) === vv(D); let side = 0;
    if (tie && tv > 0) side += tv * 11; if (tie && cv > 0 && isRed(P) === isRed(D)) side += cv * 21; side = cents(Math.min(MAXPAY, side));
    const extra = cents(tv + cv);
    if (tie) return { extra, side, st: { sh, st: stake, P, D, side }, view: { P, D, tie: true, side } };
    const w = vv(P) > vv(D); return { extra, side, done: true, mult: w ? 2 : 0, label: w ? 'You win' : 'Dealer wins', view: { P, D, tie: false, side, res: w ? 'win' : 'lose' } }; },
  cost(st, a) { return a.k === 'war' ? st.st : 0; },
  abandon(d, st) { return { done: true, mult: .5, label: 'Surrendered', view: { P: st.P, D: st.D, res: 'lose', sur: true } }; },
  act(d, st, a) { if (a.k === 'sur') return { done: true, mult: .5, label: 'Surrendered', view: { P: st.P, D: st.D, res: 'lose', sur: true } };
    if (a.k !== 'war') throw err('bad move'); const P = shoeDraw(st.sh, d), D = shoeDraw(st.sh, d), x = vv(P), y = vv(D), w = x > y, t = x === y;
    return { done: true, war: true, bf: 2, mult: t ? 3 : w ? 1.5 : 0, label: t ? 'Double tie bonus 4:1' : w ? 'War won' : 'War lost', view: { P, D, res: t ? 'tie' : w ? 'win' : 'lose', war: true } }; } };

// ---- Blackjack (full hand logic on the server) ----
const bjv = h => { let t = 0, a = 0; h.forEach(c => { t += c.r === 1 ? 11 : Math.min(c.r, 10); if (c.r === 1) a++; }); while (t > 21 && a-- > 0) t -= 10; return t; };
const bcv = c => Math.min(c.r, 10), isBJ = h => h.length === 2 && bjv(h) === 21;
const ppRes = (a, c) => a.r !== c.r ? null : a.s === c.s ? ['Perfect Pair', 25] : isRed(a) === isRed(c) ? ['Coloured Pair', 12] : ['Mixed Pair', 6];
const t3Res = cs => { const same = cs.every(c => c.s === cs[0].s), trip = cs.every(c => c.r === cs[0].r), rs = cs.map(c => c.r).sort((x, y) => x - y);
  const str = (rs[1] === rs[0] + 1 && rs[2] === rs[1] + 1) || (rs[0] === 1 && rs[1] === 12 && rs[2] === 13);
  if (trip && same) return ['Suited Trips', 100]; if (str && same) return ['Straight Flush', 40]; if (trip) return ['Three of a Kind', 30]; if (str) return ['Straight', 10]; if (same) return ['Flush', 5]; return null; };
const bjPub = G => ({ hands: G.hands.map(h => ({ cards: h.cards, bet: h.bet, done: !!h.done, bust: !!h.bust, bj: !!h.bj, dbl: !!h.dbl, stand: !!h.stand, m: h.m, res: h.res })), ai: G.ai, phase: G.phase, dealer: G.hole ? [G.dealer[0]] : G.dealer, hole: G.hole, ins: G.ins, pp: G.pp, t3: G.t3, W: G.W });
const Blackjack = { lim: [0.01, 10000], needs: 'stake',
  cost(G, a) { if (G.phase === 'insure') return a.k === 'yes' ? cents(G.hands[0].bet / 2) : 0; const h = G.hands[G.ai]; return h && (a.k === 'double' || a.k === 'split') ? h.bet : 0; },
  abandon(d, G) { if (G.phase === 'insure') { G.phase = 'play'; if (isBJ(G.dealer)) { G.hole = false; return BJ.finish(G, 0); } const hh = G.hands[0]; if (isBJ(hh.cards)) { hh.bj = true; hh.done = true; } }
    G.hands.forEach(h => { if (!h.done) { h.done = true; h.stand = true; } }); return BJ.dealer(d, G, 0); },
  start(d, p, stake) { const pv = cents(+p.pp || 0), tv = cents(+p.t3 || 0); if (pv < 0 || tv < 0 || pv > 100 || tv > 100) throw err('Maximum sidebet is 100.00'); if ((pv > 0 && pv < .01) || (tv > 0 && tv < .01)) throw err('Minimum sidebet is 0.01');
    const sh = mkShoe(), dc = () => shoeDraw(sh, d), G = { sh, hands: [{ cards: [], bet: stake }], dealer: [], hole: true, phase: 'play', W: stake, ins: 0, ai: 0, pp: pv ? { amt: pv } : null, t3: tv ? { amt: tv } : null, extra: 0, payout: 0 };
    G.hands[0].cards.push(dc()); G.dealer.push(dc()); G.hands[0].cards.push(dc()); G.dealer.push(dc());
    const [a, c] = G.hands[0].cards, up = G.dealer[0];
    [['pp', ppRes(a, c)], ['t3', t3Res([a, c, up])]].forEach(([k, r]) => { if (!G[k]) return; if (r) { const pay = Math.min(MAXPAY, cents(G[k].amt * (r[1] + 1))); G[k] = { ...G[k], res: r[0], pay }; G.payout += pay; } else G[k] = { ...G[k], res: 'No win', pay: 0 }; });
    G.extra = cents(pv + tv); G.W = stake; // main wager only; sides are separate
    if (up.r === 1) { G.phase = 'insure'; return { extra: G.extra, sidePay: G.payout, st: G, view: bjPub(G) }; }
    return BJ.afterInsure(d, G, G.extra); },
  afterInsure(d, G, extra) { const up = G.dealer[0];
    if (bcv(up) === 10 || up.r === 1) { if (isBJ(G.dealer)) { G.hole = false; return BJ.finish(G, extra); } }
    G.phase = 'play'; const h = G.hands[0]; if (isBJ(h.cards)) { h.bj = true; h.done = true; return BJ.dealer(d, G, extra); }
    return { extra, sidePay: G.payout, st: G, view: bjPub(G) }; },
  advance(d, G) { const nx = G.hands.findIndex(h => !h.done); if (nx < 0) return BJ.dealer(d, G); G.ai = nx; return { st: G, view: bjPub(G) }; },
  dealer(d, G, extra) { G.phase = 'dealer'; G.hole = false; if (G.hands.some(h => !h.bust && !h.bj)) { const dc = () => shoeDraw(G.sh, d); while (bjv(G.dealer) < 17) G.dealer.push(dc()); } return BJ.finish(G, extra); },
  finish(G, extra) { const dv = bjv(G.dealer), dbj = isBJ(G.dealer); let P = 0;
    G.hands.forEach(h => { h.bj = G.hands.length === 1 && !h.fromSplit && isBJ(h.cards); let m;
      if (h.bust) m = 0; else if (h.bj) m = dbj ? 1 : 2.5; else if (dbj) m = 0; else { const pv2 = bjv(h.cards); m = dv > 21 || pv2 > dv ? 2 : pv2 === dv ? 1 : 0; }
      h.m = m; h.res = m > 1 ? 'win' : m === 1 ? 'push' : 'lose'; P += h.bet * m; });
    if (dbj && G.ins) P += G.ins * 3; G.hole = false; G.phase = 'over'; const W = G.W, h0 = G.hands[0], net = P - W;
    const label = G.hands.length === 1 ? (h0.bj ? (dbj ? 'Both blackjack, push' : 'Blackjack!') : h0.bust ? 'Bust' : dbj ? 'Dealer blackjack' : h0.res === 'win' ? 'You win' : h0.res === 'push' ? 'Push' : 'Dealer wins') : (net > 0 ? 'You win' : net === 0 ? 'Push' : 'Dealer wins');
    return { done: true, payoutExtra: G.payout, payTotal: cents(Math.min(MAXPAY, P)), mult: W ? P / W : 0, wagered: W, label, extra, view: bjPub(G) }; },
  act(d, G, a, stake) { const dc = () => shoeDraw(G.sh, d), h = G.hands[G.ai], k = a.k;
    if (G.phase === 'insure') { if (k !== 'yes' && k !== 'no') throw err('bad move'); let ex = 0; if (k === 'yes') { ex = cents(G.hands[0].bet / 2); G.ins = ex; G.W = cents(G.W + ex); }
      const up = G.dealer[0]; G.phase = 'play'; if (isBJ(G.dealer)) { G.hole = false; const r = BJ.finish(G, ex); r.addStake = ex; return r; }
      const hh = G.hands[0]; if (isBJ(hh.cards)) { hh.bj = true; hh.done = true; const r = BJ.dealer(d, G, ex); r.addStake = ex; return r; }
      return { addStake: ex, st: G, view: bjPub(G) }; }
    if (G.phase !== 'play') throw err('Round is over');
    if (k === 'hit') { h.cards.push(dc()); const v = bjv(h.cards); if (v >= 21) { h.done = true; if (v > 21) h.bust = true; return BJ.advance(d, G); } return { st: G, view: bjPub(G) }; }
    if (k === 'stand') { h.done = true; h.stand = true; return BJ.advance(d, G); }
    if (k === 'double') { if (h.cards.length !== 2) throw err("You can't double now"); const ex = h.bet; G.W = cents(G.W + ex); h.bet *= 2; h.dbl = true; h.cards.push(dc()); h.done = true; if (bjv(h.cards) > 21) h.bust = true; const r = BJ.advance(d, G); r.addStake = ex; return r; }
    if (k === 'split') { if (h.cards.length !== 2 || bcv(h.cards[0]) !== bcv(h.cards[1]) || G.hands.length >= 4) throw err("You can't split now"); const ex = h.bet; G.W = cents(G.W + ex);
      const [c1, c2] = h.cards, aces = c1.r === 1, h2 = { cards: [c2], bet: h.bet, fromSplit: true, aces }; h.cards = [c1]; h.fromSplit = true; h.aces = aces; G.hands.splice(G.ai + 1, 0, h2); h.cards.push(dc()); h2.cards.push(dc());
      if (aces) { h.done = true; h2.done = true; } else [h, h2].forEach(x => { if (bjv(x.cards) === 21) x.done = true; });
      const r = BJ.advance(d, G); r.addStake = ex; return r; }
    throw err('bad move'); } };
const BJ = Blackjack;

// ---- Upgrader ----
const upChance = (S, T) => T > S && S > 0 ? Math.min(.95, .96 * K * S / T) : 0;
const Upgrader = { roll(d, S, T) { const ch = upChance(S, T); if (!(ch >= .0001)) throw err('Win chance is too low. Pick a cheaper target.'); const u = d(); return { ch, u, win: u < ch }; } };

// what a page needs to carry on with a round that was left open (hidden cards, mines and traps stay hidden)
Mines.resume = st => ({ view: { open: st.open, N: st.N, n: st.n }, p: { side: st.side, mines: st.n } });
HiLo.resume = st => ({ view: { cur: st.cur, m: st.m, sk: st.sk, g: st.g }, p: {} });
Tower.resume = st => ({ view: { row: st.row, C: st.C, BD: st.BD, picks: st.picks }, p: { di: st.di } });
Chicken.resume = st => ({ view: { k: st.k }, p: { d: st.di } });
Blackjack.resume = G => ({ view: bjPub(G), p: {} });
// approximate theoretical house edge per game (share of each stake the house keeps); rakeback pays back 4% of it on every wager
const EDGE = { Dice: 1 - .99 * K, Limbo: 1 - .99 * K, 'Coin Flip': 1 - .98 * K, Plinko: .03, Keno: .03, Mines: 1 - .96 * K, Tower: 1 - .96 * K, 'Duck Cross': 1 - .96 * K, 'Hi-Lo': 1 - .96 * K, Roulette: .027, Blackjack: .005, Baccarat: .0124 };
module.exports = {
  EDGE, MAXPAY, UPCAT, Dice, Limbo, Flip, Roulette, Plinko, Keno, Baccarat, Mines, HiLo, Tower, Chicken, War, Blackjack, Upgrader, upChance, cents, plTbl, mnMult, twM, chM, hlStep, err, TWD, CHD, GAMES: { Dice, Limbo, 'Coin Flip': Flip, Roulette, Plinko, Keno, Baccarat, Mines, 'Hi-Lo': HiLo, Tower, 'Duck Cross': Chicken, War, Blackjack } };
