/**
 * ChessburgerBot - Twitch chess stats bot
 * Copyright (c) 2025 TrailerParkPawn(rrogacz92@gmail.com)
 * Licensed under the MIT License
 * See LICENSE file for details
 */

// Install dependencies if not already:
// npm install node-fetch
require('dotenv').config();

const fetch = require("node-fetch");
const tmi = require("tmi.js");
const fs = require("fs");

// ---- Load joined channels from file ----
let joinedChannels = [];
const channelsFile = "channels.json";

if (fs.existsSync(channelsFile)) {
  joinedChannels = JSON.parse(fs.readFileSync(channelsFile));
} else {
  fs.writeFileSync(channelsFile, JSON.stringify([]));
}

// ---- Bot Config ----
const client = new tmi.Client({
  options: { debug: true },
  connection: { reconnect: true },
  identity: {
    username: process.env.TWITCH_USERNAME,
    password: process.env.OAUTH_TOKEN
  },
  channels: joinedChannels.length > 0 ? joinedChannels : ["chessburgerbot"]
});

client.connect();

client.on('connected', (addr, port) => {
  console.log(`Bot connected to ${addr}:${port}`);
  joinedChannels.forEach(channel => {
    client.say(channel, "ChessburgerBot is online! Type !hello or !commands");
  });
});

function saveChannels() {
  fs.writeFileSync(channelsFile, JSON.stringify(joinedChannels, null, 2));
}

// -------------------- GET STATS --------------------
async function getStats(username, periodStart, periodEnd, periodType) {
    console.log(`=== Calculating stats for ${username} (${periodType}) ===`);
    console.log(`Period start: ${periodStart}, end: ${periodEnd}`);

    let monthsToFetch = new Set();
    const now = new Date();

    const startMonth = periodStart.getUTCMonth() + 1;
    const startYear = periodStart.getUTCFullYear();
    const endMonth = periodEnd.getUTCMonth() + 1;
    const endYear = periodEnd.getUTCFullYear();

    // Include previous month for start rating purposes
    const prevDate = new Date(Date.UTC(startYear, startMonth - 2, 1)); // JS month 0-indexed
    monthsToFetch.add(`${prevDate.getUTCFullYear()}-${prevDate.getUTCMonth() + 1}`);

    if (periodType === "daily" || periodType === "weekly" || periodType === "monthly") {
        monthsToFetch.add(`${startYear}-${startMonth}`);
        if (periodType === "weekly" && startMonth !== endMonth) {
            monthsToFetch.add(`${endYear}-${endMonth}`);
        }
    } else if (periodType === "yearly") {
        // Add previous December
        monthsToFetch.add(`${startYear - 1}-12`);
        let iter = new Date(Date.UTC(startYear, 0, 1));
        while (iter <= periodEnd) {
            monthsToFetch.add(`${iter.getUTCFullYear()}-${iter.getUTCMonth() + 1}`);
            iter.setUTCMonth(iter.getUTCMonth() + 1);
        }
    }

    // Remove future months
    monthsToFetch = new Set([...monthsToFetch].filter(m => {
        const [y, mon] = m.split('-').map(Number);
        if (y > now.getUTCFullYear()) return false;
        if (y === now.getUTCFullYear() && mon > (now.getUTCMonth() + 1)) return false;
        return true;
    }));

    monthsToFetch = new Set([...monthsToFetch].sort());
    console.log("Fetching months:", [...monthsToFetch]);

    let allGames = [];

    async function fetchGamesForMonth(username, year, month) {
        const url = `https://api.chess.com/pub/player/${username}/games/${year}/${month.toString().padStart(2, '0')}`;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.error(`Failed to fetch ${year}/${month}: ${res.status} ${res.statusText}`);
                const text = await res.text();
                console.error(`API response: ${text}`);
                return [];
            }
            const data = await res.json();
            return data.games || [];
        } catch (err) {
            console.error(`Error fetching ${year}/${month}:`, err.message);
            return [];
        }
    }

    // Fetch all games for selected months
    for (const monthStr of monthsToFetch) {
        const [year, month] = monthStr.split('-');
        console.log(`Fetching games for ${year}/${month}...`);
        const games = await fetchGamesForMonth(username, year, month);
        allGames.push(...games);
    }

    // Filter games in period
    const gamesInPeriod = allGames.filter(g => {
        const gDate = new Date(g.end_time * 1000);
        return gDate >= periodStart && gDate <= periodEnd;
    });

    const stats = { rapid: { count: 0 }, blitz: { count: 0 }, bullet: { count: 0 } };
    const startRatings = { rapid: null, blitz: null, bullet: null };
    const endRatings = { rapid: null, blitz: null, bullet: null };
    const lastGameBefore = { rapid: null, blitz: null, bullet: null };

    allGames.sort((a, b) => a.end_time - b.end_time);

    // Determine last game before period for start rating
    for (const mode of ["rapid", "blitz", "bullet"]) {
        const lastBefore = allGames.filter(g => g.time_class === mode && new Date(g.end_time * 1000) < periodStart).pop();
        if (lastBefore) {
            lastGameBefore[mode] = lastBefore;
            startRatings[mode] = lastBefore.white.username.toLowerCase() === username.toLowerCase()
                ? lastBefore.white.rating
                : lastBefore.black.rating;
        }
    }

    // Count games and end ratings safely
    for (const mode of ["rapid", "blitz", "bullet"]) {
        const modeGames = gamesInPeriod.filter(g => g.time_class === mode);
        stats[mode].count = modeGames.length;

        if (modeGames.length) {
            const last = modeGames[modeGames.length - 1];
            endRatings[mode] = last.white.username.toLowerCase() === username.toLowerCase()
                ? last.white.rating
                : last.black.rating;
        }

        // Start rating fallback if null
        if (startRatings[mode] === null) {
            const firstInPeriod = modeGames[0];
            if (firstInPeriod) {
                startRatings[mode] = firstInPeriod.white.username.toLowerCase() === username.toLowerCase()
                    ? firstInPeriod.white.rating
                    : firstInPeriod.black.rating;
            }
        }
    }

    console.log("Total games fetched:", allGames.length);
    console.log("Games in period:", gamesInPeriod.length);
    console.log("[DEBUG] Start Ratings:", startRatings);
    console.log("[DEBUG] End Ratings:", endRatings);
    console.log("[DEBUG] Stats:", stats);

    return { stats, startRatings, endRatings, gamesInPeriod };
}


// -------------------- GET LAST GAME --------------------
async function getLastGame(username) {
    console.log(`Fetching last game for ${username}...`);
    try {
        const res = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`);
        if (!res.ok) {
            console.error(`Failed to fetch archives: ${res.status} ${res.statusText}`);
            return null;
        }
        const data = await res.json();
        const archives = data.archives;
        if (!archives || archives.length === 0) {
            console.log(`No archives found for ${username}`);
            return null;
        }
        const latestArchiveUrl = archives[archives.length - 1];
        console.log(`Fetching latest archive: ${latestArchiveUrl}`);
        const archiveRes = await fetch(latestArchiveUrl);
        if (!archiveRes.ok) {
            console.error(`Failed to fetch latest archive: ${archiveRes.status} ${archiveRes.statusText}`);
            return null;
        }
        const archiveData = await archiveRes.json();
        const games = archiveData.games;
        if (!games || games.length === 0) {
            console.log(`No games found in latest archive for ${username}`);
            return null;
        }
        const lastGame = games[games.length - 1];
        const isWhite = lastGame.white.username.toLowerCase() === username.toLowerCase();
        const color = isWhite ? 'white' : 'black';

        let result = 'draw';
        if ((isWhite && lastGame.white.result === 'win') || (!isWhite && lastGame.black.result === 'win')) result = 'won';
        if ((isWhite && lastGame.white.result === 'lose') || (!isWhite && lastGame.black.result === 'lose')) result = 'lost';

        // Clean PGN
        let pgn = lastGame.pgn || '';
        // Remove all headers
        pgn = pgn.replace(/\[.*?\]\n/g, '');
        // Remove { ... } comments
        pgn = pgn.replace(/\{.*?\}/g, '');
        // Remove numbers with double dots (1... e5)
        pgn = pgn.replace(/\d+\.\.\./g, '');
        // Normalize whitespace
        pgn = pgn.replace(/\s+/g, ' ').trim();

        console.log(`Last game: ${color}, ${result}`);
        return { color, result, pgn };

    } catch (err) {
        console.error(`Error in getLastGame:`, err);
        return null;
    }
}

// ---------------------- MSG HANDLERS ----------------------
client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const parts = message.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const username = parts[1];
    if (!username) return;

    const now = new Date();
    let periodStart, periodEnd, periodType;

    if (command === '!daily') {
        periodType = 'daily';
        periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
        periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
    } else if (command === '!weekly') {
        periodType = 'weekly';
        const day = now.getUTCDay();
        const diff = day === 0 ? 6 : day - 1;
        const start = new Date(now);
        start.setUTCDate(now.getUTCDate() - diff);
        periodStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0));
        periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
    } else if (command === '!monthly') {
        periodType = 'monthly';
        periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
        periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    } else if (command === '!yearly') {
        periodType = 'yearly';
        periodStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));
        periodEnd = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59));
    }

    if (['!daily', '!weekly', '!monthly', '!yearly'].includes(command)) {
        console.log(`=== Calculating stats for ${username} (${periodType}) ===`);
        console.log(`Period start: ${periodStart.toUTCString()}, end: ${periodEnd.toUTCString()}`);

        try {
            const { stats, startRatings, endRatings, gamesInPeriod } = await getStats(username, periodStart, periodEnd, periodType);

            const totalGames = gamesInPeriod.length;
            const totalGamesStr = totalGames === 1 ? '1 game' : `${totalGames} games`;

            const rapidStr = `${stats.rapid.count} ${stats.rapid.count === 1 ? 'Rapid game' : 'Rapid games'}`;
            const blitzStr = `${stats.blitz.count} ${stats.blitz.count === 1 ? 'Blitz game' : 'Blitz games'}`;
            const bulletStr = `${stats.bullet.count} ${stats.bullet.count === 1 ? 'Bullet game' : 'Bullet games'}`;

            const rapidRating = stats.rapid.count > 0 && startRatings.rapid != null && endRatings.rapid != null ? 
                `, rating: ${endRatings.rapid - startRatings.rapid >= 0 ? '+' : ''}${endRatings.rapid - startRatings.rapid} (${startRatings.rapid} -> ${endRatings.rapid})` : '';

            const blitzRating = stats.blitz.count > 0 && startRatings.blitz != null && endRatings.blitz != null ? 
                `, rating: ${endRatings.blitz - startRatings.blitz >= 0 ? '+' : ''}${endRatings.blitz - startRatings.blitz} (${startRatings.blitz} -> ${endRatings.blitz})` : '';

            const bulletRating = stats.bullet.count > 0 && startRatings.bullet != null && endRatings.bullet != null ? 
                `, rating: ${endRatings.bullet - startRatings.bullet >= 0 ? '+' : ''}${endRatings.bullet - startRatings.bullet} (${startRatings.bullet} -> ${endRatings.bullet})` : '';

            const periodName = periodType === 'yearly' ? 'this year' : periodType === 'monthly' ? 'this month' : periodType === 'weekly' ? 'this week' : 'today';

            const msg = `${username} has played ${totalGamesStr} ${periodName}. ${rapidStr}${rapidRating}, ${blitzStr}${blitzRating}, ${bulletStr}${bulletRating}`;

            await client.say(channel, msg);

        } catch (err) {
            console.error(`Error fetching stats for ${username}:`, err);
            client.say(channel, `Error fetching stats for ${username}`);
        }
    }

    if (command === '!recent') {
        try {
            const lastGame = await getLastGame(username);
            if (!lastGame) {
                await client.say(channel, `No recent games found for ${username}.`);
                return;
            }
            const msg = `${username} has played as ${lastGame.color} and ${lastGame.result} most recent game:\n${lastGame.pgn}`;
            await client.say(channel, msg);
        } catch (err) {
            console.error(`Error fetching last game for ${username}:`, err);
            await client.say(channel, `Error fetching last game for ${username}.`);
        }
    }
});
