import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createCanvas, loadImage } from '@napi-rs/canvas';

import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

// ---------- Failsafe storage folder ----------
const ROOT_DIR = process.cwd(); // same level as package.json

const DATA_DIR = process.env.SNBANK_DATA_DIR
  || path.join(ROOT_DIR, 'SNBank_Data');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const DB_PATH = path.join(DATA_DIR, 'snbank.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- DB (lowdb) ----------
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const adapter = new JSONFile(DB_PATH);
const defaultData = { debts: [], __nextId: 1 };
const db = new Low(adapter, defaultData);

await db.read();
db.data ||= structuredClone(defaultData);

// If file missing/empty, ensure it exists on disk
await db.write();

// ---------- tiny crash logging ----------
process.on('unhandledRejection', (r) => console.error('UNHANDLED REJECTION:', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e));

// ---------- helpers ----------
const fmtSEK = (n) =>
  new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
  }).format(n);

function clampReason(text, max = 750) {
  if (!text) return '';
  const t = String(text).trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

async function resolveMemberSafe(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function resolveName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName;
  } catch {
    // member not found or bot can't see them
  }

  try {
    const user = await guild.client.users.fetch(userId);
    return user?.username ?? `Unknown User (${userId})`;
  } catch {
    return `Unknown User (${userId})`;
  }
}

function isOwner(interaction) {
  return interaction.guild?.ownerId === interaction.user.id;
}
function isAdmin(interaction) {
  return Boolean(interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
}

async function syncDebtPin(client, debtRow) {
  if (!debtRow.channel_id || !debtRow.message_id) return;

  try {
    const channel = await client.channels.fetch(debtRow.channel_id);
    if (!channel?.isTextBased?.()) return;

    const msg = await channel.messages.fetch({
      message: debtRow.message_id,
      force: true,
    });

    const shouldBePinned = debtRow.status === 'UNPAID';

    if (shouldBePinned && !msg.pinned) await msg.pin();
    if (!shouldBePinned && msg.pinned) await msg.unpin();
  } catch (e) {
    console.warn(`Pin sync failed for debt ${debtRow.id}:`, e.message);
  }
}


// ---------- DB helpers ----------
function insertDebtRow({ creator_id, borrower_id, lender_id, amount, reason, message_id, channel_id }) {
  const id = db.data.__nextId++;
  const row = {
    id,
    creator_id,
    borrower_id, // Borrower
    lender_id, // Lender
    amount,
    reason,
    status: 'UNPAID', // UNPAID | PAID | ADMIN_CLOSED
    ping_state: 'NONE', // NONE | CLAIMED (🔔 vs ❗)
    message_id,
    channel_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.data.debts.push(row);
  return row;
}

const getDebtById = (id) => db.data.debts.find((d) => d.id === id);

async function setMsgRef({ id, message_id, channel_id }) {
  const d = getDebtById(id);
  if (d) {
    d.message_id = message_id;
    d.channel_id = channel_id;
    d.updated_at = new Date().toISOString();
    await db.write();
  }
}

async function patchDebt(id, patch) {
  const d = getDebtById(id);
  if (!d) return null;
  Object.assign(d, patch);
  d.updated_at = new Date().toISOString();
  await db.write();
  return d;
}

async function replyToDebtCard(client, debtRow, content) {
  try {
    const channel = await client.channels.fetch(debtRow.channel_id);
    if (!channel?.isTextBased?.()) return false;

    const msg = await channel.messages.fetch({
      message: debtRow.message_id,
      force: true,
    });

    await msg.reply({ content, allowedMentions: { users: [debtRow.borrower_id, debtRow.lender_id] } });
    return true;
  } catch (e) {
    console.error('Failed to reply to debt card:', e);
    return false;
  }
}

// ---------- Fetch helper (built-in fetch OR node-fetch fallback) ----------
async function fetchAny(url) {
  if (typeof fetch === 'function') return fetch(url);
  const mod = await import('node-fetch');
  return mod.default(url);
}

// ---------- Canvas helpers ----------
function avatarUrlFor(memberOrUser) {
  const u = memberOrUser?.user ?? memberOrUser;
  if (!u?.displayAvatarURL) return null;
  return u.displayAvatarURL({
    extension: 'png',
    size: 128,
    forceStatic: true,
  });
}

async function loadImageFromUrl(url) {
  if (!url) return null;
  const res = await fetchAny(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  const arr = await res.arrayBuffer();
  return loadImage(Buffer.from(arr));
}

function drawCircleImage(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const scale = Math.max((r * 3) / img.width, (r * 3) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(162, 52, 148, 0.85)'; // Border
  ctx.lineWidth = 3;
  ctx.stroke();
}

async function buildDebtBannerPng(borrowerMember, lenderMember, rowId) {
  const W = 700;
  const H = 180;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#391b43ff'); //Left Gradient
  grad.addColorStop(1, '#162a3cff'); //Right Gradient
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(198, 53, 224, 0.15)'; // Left Circle
  ctx.beginPath();
  ctx.arc(120, 60, 90, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(44, 114, 135, 0.2)'; // Right Circle
  ctx.beginPath();
  ctx.arc(W - 120, 120, 100, 0, Math.PI * 2);
  ctx.fill();

  const borrowerUrl = avatarUrlFor(borrowerMember);
  const lenderUrl = avatarUrlFor(lenderMember);

  let borrowerImg = null;
  let lenderImg = null;
  try {
    borrowerImg = await loadImageFromUrl(borrowerUrl);
  } catch {}
  try {
    lenderImg = await loadImageFromUrl(lenderUrl);
  } catch {}

  const r = 56;
  const leftX = 170;
  const rightX = W - 170;
  const y = H / 2;

  if (borrowerImg) drawCircleImage(ctx, borrowerImg, leftX, y, r);
  if (lenderImg) drawCircleImage(ctx, lenderImg, rightX, y, r);

  ctx.fillStyle = 'rgba(162, 52, 148, 0.85)'; // Arrow
  ctx.font = 'bold 100px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('→', W / 2, y);

  const buffer = await canvas.encode('png');
  const filename = `debt-banner-${rowId}.png`;
  const attachment = new AttachmentBuilder(buffer, { name: filename });

  return { attachment, filename };
}

// ---------- Embed ----------
async function buildDebtEmbed(guild, row) {
  const creatorName = await resolveName(guild, row.creator_id);

  const statusText =
    row.status === 'PAID' ? 'PAID' : row.status === 'ADMIN_CLOSED' ? 'Closed by Admin' : 'UNPAID';

  const color =
  row.status === 'UNPAID'
    ? 0xe74c3c // red
    : row.status === 'ADMIN_CLOSED'
    ? 0xf1c40f // yellow
    : 0x2ecc71; // green

  const borrowerMember = await resolveMemberSafe(guild, row.borrower_id);
  const lenderMember = await resolveMemberSafe(guild, row.lender_id);

  const reason = clampReason(row.reason);

  const description = [`**Reason:**`, '```' + `${reason || '—'}` + '```'].join('\n');

  const { attachment, filename } = await buildDebtBannerPng(borrowerMember, lenderMember, row.id);

  const embed = new EmbedBuilder()
    .setTitle(`Debt — ${borrowerMember.displayName} owes ${lenderMember.displayName}`)
    .setDescription(description)
    .setImage(`attachment://${filename}`)
    .addFields(
      { name: 'Lender', value: `<@${row.lender_id}>`, inline: true },
      { name: 'Borrower', value: `<@${row.borrower_id}>`, inline: true },
      { name: 'Amount', value: fmtSEK(row.amount), inline: true }
    )
    .setFooter({
      text: `Status: ${statusText} - Last Updated ${new Date(row.updated_at).toLocaleString()}\nCreated By: ${creatorName}\nDebt ID: ${row.id}`,
    })
    .setColor(color);

  return { embed, files: [attachment] };
}

// ---------- Buttons (max 5 in a row) ----------
function componentsFor(row) {
  const unpaid = row.status === 'UNPAID';
  const canReopen = row.status !== 'UNPAID';
  const pingEmoji = row.ping_state === 'CLAIMED' ? '❗' : '🔔';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`debt:paid:${row.id}`)
        .setLabel('Mark Paid')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!unpaid),

      new ButtonBuilder()
        .setCustomId(`debt:ping:${row.id}`)
        .setEmoji(pingEmoji)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!unpaid),

      new ButtonBuilder()
        .setCustomId(`debt:edit:${row.id}`)
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!unpaid),

      new ButtonBuilder()
        .setCustomId(`debt:adminclose:${row.id}`)
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!unpaid),

      new ButtonBuilder()
        .setCustomId(`debt:reopen:${row.id}`)
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!canReopen),
    ),
  ];
}

function overviewComponents(type, id) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`refresh:${type}:${id}`)
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ---------- Aggregation ----------
function statsForUser(userId) {
  const valid = (d) => d.status !== 'ADMIN_CLOSED';

  const mineAsBorrower = db.data.debts.filter(
    (d) => d.borrower_id === userId && valid(d)
  );
  const mineAsLender = db.data.debts.filter(
    (d) => d.lender_id === userId && valid(d)
  );

  const currentOutgoing = mineAsBorrower
    .filter((d) => d.status === 'UNPAID')
    .reduce((s, d) => s + d.amount, 0);

  const currentIncoming = mineAsLender
    .filter((d) => d.status === 'UNPAID')
    .reduce((s, d) => s + d.amount, 0);

  const lifetimeOutgoing = mineAsBorrower.reduce((s, d) => s + d.amount, 0);
  const lifetimeIncoming = mineAsLender.reduce((s, d) => s + d.amount, 0);

  const settledOutgoing = mineAsBorrower
    .filter((d) => d.status === 'PAID')
    .reduce((s, d) => s + d.amount, 0);

  const settledIncoming = mineAsLender
    .filter((d) => d.status === 'PAID')
    .reduce((s, d) => s + d.amount, 0);

  return {
    counts: {
      openAsBorrower: mineAsBorrower.filter((d) => d.status === 'UNPAID').length,
      openAsLender: mineAsLender.filter((d) => d.status === 'UNPAID').length,
    },
    current: {
      outgoing: currentOutgoing,
      incoming: currentIncoming,
      net: currentIncoming - currentOutgoing,
    },
    lifetime: {
      outgoing: lifetimeOutgoing,
      incoming: lifetimeIncoming,
      settledOutgoing,
      settledIncoming,
    },
  };
}

function uniqueUserIdsInDb() {
  const set = new Set();
  for (const d of db.data.debts) {
    if (d.status === 'ADMIN_CLOSED') continue;
    set.add(d.borrower_id);
    set.add(d.lender_id);
    set.add(d.creator_id);
  }
  return [...set];
}

async function buildOutgoingBreakdown(guild, userId, maxLines = 12) {
  const map = new Map();
  for (const d of db.data.debts) {
    if (d.borrower_id === userId && d.status === 'UNPAID') {
      map.set(d.lender_id, (map.get(d.lender_id) || 0) + d.amount);
    }
  }
  if (map.size === 0) return '—';

  const entries = await Promise.all(
    [...map.entries()].map(async ([uid, amt]) => ({
      name: await resolveName(guild, uid),
      amount: amt,
    }))
  );
  entries.sort((a, b) => b.amount - a.amount);

  const lines = [];
  let used = 0;
  for (const e of entries) {
    const line = `• ${e.name} — ${fmtSEK(e.amount)}`;
    if (lines.length >= maxLines) break;
    if (used + line.length + (lines.length ? 1 : 0) > 950) break;
    lines.push(line);
    used += line.length + (lines.length ? 1 : 0);
  }
  const leftover = entries.length - lines.length;
  if (leftover > 0) lines.push(`… and ${leftover} more`);
  return lines.join('\n');
}

// ---------- Leaderboard helpers ----------
function medalForRank(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return `#${i + 1}`;
}

async function buildLeaderboardText(guild, entries) {
  if (!entries.length) return '—';

  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = await resolveName(guild, e.userId);
    lines.push(`${medalForRank(i)} **${name}** — ${fmtSEK(e.amount)}`);
  }
  return lines.join('\n');
}

async function buildLeaderboardEmbed(guild) {
  const ids = uniqueUserIdsInDb();
  if (ids.length === 0) {
    return new EmbedBuilder().setTitle('Debt Leaderboard').setDescription('No debt history yet.').setColor(0x5865f2);
  }

  // Podium #1: Current outgoing (UNPAID, owed to others)
  const currentOutgoing = ids
    .map((uid) => ({ userId: uid, amount: statsForUser(uid).current.outgoing }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Podium #2: All-time outgoing (ever owed to others)
  const lifetimeOutgoing = ids
    .map((uid) => ({ userId: uid, amount: statsForUser(uid).lifetime.outgoing }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Podium #3: All-time incoming (ever owed to you)
  const lifetimeIncoming = ids
    .map((uid) => ({ userId: uid, amount: statsForUser(uid).lifetime.incoming }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const embed = new EmbedBuilder()
    .setTitle('Debt Leaderboard')
    .setDescription('Top borrowers and lenders in this server.')
    .addFields(
      {
        name: 'Podium #1 — Current Outgoing',
        value: await buildLeaderboardText(guild, currentOutgoing),
        inline: false,
      },
      {
        name: 'Podium #2 — All-time outgoing',
        value: await buildLeaderboardText(guild, lifetimeOutgoing),
        inline: false,
      },
      {
        name: 'Podium #3 — All-time incoming',
        value: await buildLeaderboardText(guild, lifetimeIncoming),
        inline: false,
      }
    )
    .setColor(0x5865f2);

  return embed;
}

// ---------- Client ----------
const client = new Client({
intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers,
],
  partials: [Partials.Message, Partials.Channel],
});

// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('debt')
    .setDescription('SNBank commands')
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Create a debt record')
        .addUserOption((o) => o.setName('borrower').setDescription('The person who owes the money').setRequired(true))
        .addUserOption((o) => o.setName('lender').setDescription('The person who is owed the money').setRequired(true))
        .addNumberOption((o) => o.setName('amount').setDescription('Amount owed (SEK)').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('What is this for?').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('user')
        .setDescription('Show a user’s debt (current & lifetime)')
        .addUserOption((o) => o.setName('user').setDescription('User to inspect (defaults to you)').setRequired(false))
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('Summary of every member’s debt stats (anyone with history)'))
    .addSubcommand((sc) => sc.setName('leaderboard').setDescription('Top debt podiums (current + all-time)'))
    .addSubcommand((sc) => sc.setName('reset').setDescription('Owner: Reset ALL stored debts and stats to none'))
    .addSubcommand((sc) => sc.setName('help').setDescription('Show SNBank command help and button reference'))
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✓ Slash commands registered (guild).');
}

// Helper to build /debt list embeds
async function buildListEmbeds(guild) {
  const ids = uniqueUserIdsInDb();
  if (!ids.length) return [new EmbedBuilder().setDescription('No debt history yet.')];

  const rows = [];
  for (const id of ids) {
    const s = statsForUser(id);
    rows.push({
      name: await resolveName(guild, id),
      currentNet: s.current.net,
      currentOutgoing: s.current.outgoing,
      currentIncoming: s.current.incoming,
      openBorrower: s.counts.openAsBorrower,
      openLender: s.counts.openAsLender,
    });
  }

  rows.sort((a, b) => b.currentNet - a.currentNet);

  const MAX_DESC = 3500;
  const pages = [];
  let buf = '';
  const blockFor = (r) =>
    [
      `**${r.name}**`,
      `Outgoing: ${fmtSEK(r.currentOutgoing)}`,
      `Incoming: ${fmtSEK(r.currentIncoming)}`,
      `Net: ${fmtSEK(r.currentNet)}`,
      `Open: ${r.openBorrower}/${r.openLender}`,
    ].join('\n');

  for (const r of rows) {
    const block = blockFor(r);
    const next = buf ? `${buf}\n\n${block}` : block;
    if (next.length > MAX_DESC) {
      pages.push(buf);
      buf = block;
    } else {
      buf = next;
    }
  }
  if (buf) pages.push(buf);

  return pages.map((p) => new EmbedBuilder().setTitle('Debt Summary — All Users').setDescription(p).setColor(0x5865f2));
}

async function buildUserEmbed(guild, userId) {
  const s = statsForUser(userId);
  const breakdown = await buildOutgoingBreakdown(guild, userId);

  // Fetch fresh user globally
  const user = await guild.client.users.fetch(userId, { force: true });
  const name = user?.username ?? 'Unknown User';

  // Always fetch latest avatar
  const avatar = user.displayAvatarURL({
    size: 256,
    extension: 'png',
    forceStatic: false, // animated avatars stay animated
  });

  const embed = new EmbedBuilder()
    .setTitle(`Debt Summary — ${name}`)
    .addFields(
      { name: 'Current Outgoing Debt', value: fmtSEK(s.current.outgoing), inline: true },
      { name: 'Current Incoming Debt', value: fmtSEK(s.current.incoming), inline: true },
      { name: 'Net', value: fmtSEK(s.current.net), inline: true },
      { name: 'Lifetime Outgoing Debt', value: fmtSEK(s.lifetime.outgoing), inline: true },
      { name: 'Lifetime Incoming Debt', value: fmtSEK(s.lifetime.incoming), inline: true },
      {
        name: 'Lifetime Settled',
        value: `${fmtSEK(s.lifetime.settledOutgoing)} / ${fmtSEK(s.lifetime.settledIncoming)}`,
        inline: true,
      },
      {
        name: 'Open Debts',
        value: `As Borrower: ${s.counts.openAsBorrower} • As Lender: ${s.counts.openAsLender}`,
        inline: false,
      },
      { name: 'Owes (UNPAID breakdown)', value: breakdown, inline: false }
    )
    .setColor(0x5865f2)
    .setThumbnail(avatar); // <-- this will always show latest avatar

  return embed;
}


client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`DB path: ${DB_PATH}`);

  for (const d of db.data.debts) {
    if (d.message_id && d.channel_id) {
      await syncDebtPin(client, d);
    }
  }

  await registerCommands();
});

// ---------- Slash command handler ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'debt') return;
  if (!interaction.inGuild()) return interaction.reply({ content: 'Use this in a server.', ephemeral: true });

  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const creator = interaction.user;
    const borrower = interaction.options.getUser('borrower', true);
    const lender = interaction.options.getUser('lender', true);
    const amount = interaction.options.getNumber('amount', true);
    const reason = interaction.options.getString('reason', true);

    if (borrower.id === lender.id) {
      return interaction.reply({ content: 'Borrower and Lender must be different users.', ephemeral: true });
    }
    if (amount <= 0) {
      return interaction.reply({ content: 'Amount must be greater than 0.', ephemeral: true });
    }

    const row = insertDebtRow({
      creator_id: creator.id,
      borrower_id: borrower.id,
      lender_id: lender.id,
      amount,
      reason,
      message_id: null,
      channel_id: interaction.channelId,
    });
    await db.write();

    const { embed, files } = await buildDebtEmbed(guild, row);
    await interaction.reply({
      embeds: [embed],
      files,
      components: componentsFor(row)
    });

    const msg = await interaction.fetchReply();
    await setMsgRef({ id: row.id, message_id: msg.id, channel_id: msg.channel.id });
    await syncDebtPin(client, getDebtById(row.id));
    return;
  }

  if (sub === 'user') {
    const target = interaction.options.getUser('user') ?? interaction.user;

    // Build the embed in one place
    const embed = await buildUserEmbed(guild, target.id);

    // Send it once, with refresh button
    await interaction.reply({
      embeds: [embed],
      components: overviewComponents('user', target.id)
    });
  }

  if (sub === 'list') {
    await interaction.deferReply();
    const embeds = await buildListEmbeds(guild);
    await interaction.editReply({ embeds: [embeds[0]], components: overviewComponents('list', 0) });
  }

  if (sub === 'leaderboard') {
    await interaction.deferReply();
    const embed = await buildLeaderboardEmbed(guild);
    await interaction.editReply({
      embeds: [embed],
      components: overviewComponents('leaderboard', 0)
    });
  }

  if (sub === 'reset') {
    if (!isOwner(interaction))
      return interaction.reply({ content: 'Only the **server owner** can use this.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const beforeCount = db.data.debts.length;
    const beforeOpen = db.data.debts.filter((d) => d.status === 'UNPAID').length;

    db.data.debts = [];
    db.data.__nextId = 1;
    await db.write();

    const embed = new EmbedBuilder()
      .setTitle('Reset Complete')
      .setDescription('All stored debts and stats have been cleared.')
      .addFields(
        { name: 'Entries removed', value: String(beforeCount), inline: true },
        { name: 'Previously UNPAID', value: String(beforeOpen), inline: true },
        { name: 'Current total', value: '0', inline: true }
      )
      .setColor(0x2ecc71);

    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('SNBank — Help')
      .setDescription('Quick reference for commands and buttons.')
      .addFields(
        {
          name: '/debt add',
          value: [
            'Create a new debt card.',
            '• **Borrower**: who owes',
            '• **Lender**: who is owed',
            '• **Amount**: SEK',
            '• **Reason**: comment',
          ].join('\n'),
          inline: false,
        },
        {
          name: '/debt user [user]',
          value: 'Shows current & lifetime totals + UNPAID “who you owe” breakdown.',
          inline: false,
        },
        { name: '/debt list', value: 'Summary for everyone with any history.', inline: false },
        { name: '/debt leaderboard', value: 'Top debts (current + all-time).', inline: false },
        { name: '/debt reset (owner only)', value: 'Wipes **all** saved debts from the database.', inline: false },
        {
          name: 'Buttons on a debt card',
          value: [
            '✅ **Mark Paid** — only the **Lender** can confirm payment.',
            '🔔/❗ **Payment Ping** — **Borrower** claims paid (🔔→❗), **Lender** can reject (❗→🔔).',
            '🔧 **Edit** — creator or owner can edit amount/reason (UNPAID only).',
            '❌ **Reopen** — **Lender** or **admins/owner** can reopen.',
            '🚫 **Admin Close** — **owner only**.',
          ].join('\n'),
          inline: false,
        }
      )
      .setColor(0x5865f2)
      .setFooter({ text: `Data stored in: ${DATA_DIR}` });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ---------- Buttons + modals ----------
client.on(Events.InteractionCreate, async (i) => {
  // --- button clicks ---
  if (i.isButton()) {
  const parts = i.customId.split(':');

  // 🔄 REFRESH BUTTONS
if (parts[0] === 'refresh') {
  const [, type, id] = parts;

  try {
    let embed;

    if (type === 'user') {
      if (!id) throw new Error('Missing userId in refresh:user');
      embed = await buildUserEmbed(i.guild, id);
    }

    if (type === 'leaderboard') {
      embed = await buildLeaderboardEmbed(i.guild);
    }

    if (type === 'list') {
      const embeds = await buildListEmbeds(i.guild);
      embed = embeds[0];
    }

    await i.update({
      embeds: [embed],
      components: overviewComponents(type, id ?? 0),
    });
  } catch (err) {
    console.error('Refresh failed:', err);
    if (!i.replied && !i.deferred) {
      await i.reply({ content: '❌ Failed to refresh.', ephemeral: true });
    }
  }

  return;
}

  // ⬇️ ONLY debt buttons below this line
  const [ns, action, idStr] = parts;
    if (ns !== 'debt') return;
    if (!i.inGuild()) return i.reply({ content: 'This can only be used in a server.', ephemeral: true });

    const guild = i.guild;
    const id = Number(idStr);
    
    if (!Number.isInteger(id)) {
      return i.reply({ content: 'Invalid debt ID.', ephemeral: true });
    }
    
    const row = getDebtById(id);
    if (!row) {
      return i.reply({ content: 'Debt not found.', ephemeral: true });
    }
    
    if (!row) return i.reply({ content: 'Debt not found.', ephemeral: true });

    const unpaid = row.status === 'UNPAID';
    const isLenderUser = i.user.id === row.lender_id;
    const isBorrowerUser = i.user.id === row.borrower_id;
    const owner = isOwner(i);
    const admin = isAdmin(i);

    // ✅ Mark Paid (Lender only)
    if (action === 'paid') {
      if (!unpaid) return i.reply({ content: 'Already processed.', ephemeral: true });
      if (!isLenderUser) return i.reply({ content: 'Only **Lender** can mark this as paid.', ephemeral: true });

      await patchDebt(row.id, { status: 'PAID', ping_state: 'NONE' });
      const updated = getDebtById(row.id);

      await syncDebtPin(client, updated);

      const { embed, files } = await buildDebtEmbed(guild, updated);
      return i.update({ embeds: [embed], files, components: componentsFor(updated) });
    }

    // ❌ Reopen (Lender or admin/owner)
    if (action === 'reopen') {
      if (unpaid) return i.reply({ content: 'Debt is already unpaid.', ephemeral: true });
      if (!(isLenderUser || admin || owner)) {
        return i.reply({ content: 'Only **Lender** or an **admin/owner** can reopen this debt.', ephemeral: true });
      }

      await patchDebt(row.id, { status: 'UNPAID' });
      const updated = getDebtById(row.id);

      await syncDebtPin(client, updated);

      const { embed, files } = await buildDebtEmbed(guild, updated);
      return i.update({ embeds: [embed], files, components: componentsFor(updated) });
    }

    // 🚫 Admin Close (owner only)
    if (action === 'adminclose') {
      if (!unpaid) return i.reply({ content: 'Already processed.', ephemeral: true });
      if (!owner) return i.reply({ content: 'Only the **server owner** can use this.', ephemeral: true });

      await patchDebt(row.id, { status: 'ADMIN_CLOSED', ping_state: 'NONE' });
      const updated = getDebtById(row.id);

      await syncDebtPin(client, updated);

      const { embed, files } = await buildDebtEmbed(guild, updated);
      await i.update({ embeds: [embed], files, components: componentsFor(updated) });
      return;
    }

    // 🔔/❗ Payment Ping
    if (action === 'ping') {
      if (!unpaid) return i.reply({ content: 'This only applies while the debt is UNPAID.', ephemeral: true });

      if (row.ping_state === 'NONE') {
        if (!isBorrowerUser) return i.reply({ content: 'Only **Borrower** can press 🔔 to claim payment was made.', ephemeral: true });

        await patchDebt(row.id, { ping_state: 'CLAIMED' });
        const updated = getDebtById(row.id);

        const { embed, files } = await buildDebtEmbed(guild, updated);
        await i.update({ embeds: [embed], files, components: componentsFor(updated) });

        await replyToDebtCard(
          client,
          updated,
          `🔔 Payment sent for this debt. <@${updated.lender_id}> please confirm with ✅, or press ❗ if you **haven’t** received it.`
        );

        return;
      }

      if (row.ping_state === 'CLAIMED') {
        if (!isLenderUser) return i.reply({ content: 'Only the **Lender** can press ❗ to say it hasn’t been received.', ephemeral: true });

        await patchDebt(row.id, { ping_state: 'NONE' });
        const updated = getDebtById(row.id);

        const { embed, files } = await buildDebtEmbed(guild, updated);
        await i.update({ embeds: [embed], files, components: componentsFor(updated) });

        await replyToDebtCard(
          client,
          updated,
          `❗ Not received yet. <@${updated.borrower_id}> the Lender says they haven’t received the payment.`
        );

        return;
      }

      return i.reply({ content: 'Unknown ping state.', ephemeral: true });
    }

    // 🔧 Edit (creator or owner) → modal
    if (action === 'edit') {
      const canEdit = owner || i.user.id === row.creator_id;
      if (!unpaid) return i.reply({ content: 'Only UNPAID debts can be edited.', ephemeral: true });
      if (!canEdit) return i.reply({ content: 'Only the **creator** or **server owner** can edit debts.', ephemeral: true });

      const modal = new ModalBuilder().setCustomId(`debt:editmodal:${row.id}`).setTitle('Edit Debt');

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Amount (SEK)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(row.amount));

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setValue(String(row.reason ?? ''));

      modal.addComponents(new ActionRowBuilder().addComponents(amountInput), new ActionRowBuilder().addComponents(reasonInput));

      return i.showModal(modal);
    }

    return i.reply({ content: 'Unknown action.', ephemeral: true });
  }

  // --- modal submit (edit) ---
  if (i.isModalSubmit()) {
    const [ns, action, idStr] = i.customId.split(':');
    if (ns !== 'debt' || action !== 'editmodal') return;
    if (!i.inGuild()) return i.reply({ content: 'Use this in a server.', ephemeral: true });

    const guild = i.guild;
    const id = Number(idStr);
    const row = getDebtById(id);
    if (!row) return i.reply({ content: 'Debt not found.', ephemeral: true });

    const unpaid = row.status === 'UNPAID';
    if (!unpaid) return i.reply({ content: 'Only UNPAID debts can be edited.', ephemeral: true });

    const owner = isOwner(i);
    const canEdit = owner || i.user.id === row.creator_id;
    if (!canEdit) return i.reply({ content: 'Only the **creator** or **server owner** can edit this debt.', ephemeral: true });

    const amountRaw = i.fields.getTextInputValue('amount');
    const reasonRaw = i.fields.getTextInputValue('reason');

    const amount = Number(String(amountRaw).replace(',', '.').trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      return i.reply({ content: 'Amount must be a valid number > 0.', ephemeral: true });
    }

    const reason = clampReason(reasonRaw, 2000);
    await patchDebt(row.id, { amount, reason });

    const updated = getDebtById(row.id);

    try {
      const channel = await client.channels.fetch(updated.channel_id);
      if (channel?.isTextBased()) {
        const msg = await channel.messages.fetch(updated.message_id);
        const { embed, files } = await buildDebtEmbed(guild, updated);
        await msg.edit({ embeds: [embed], files, components: componentsFor(updated) });
      }
    } catch (e) {
      console.error('Failed to edit debt message after modal:', e);
    }

    return i.reply({ content: '✅ Debt updated.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);