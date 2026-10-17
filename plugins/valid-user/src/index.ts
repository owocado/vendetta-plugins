import { findByProps } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
import { logger } from "@vendetta";
import { React, messageUtil } from "@vendetta/metro/common";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const lazy = (...props: string[]) => {
    let mod: any;
    return () => (mod ??= findByProps(...props));
};
const getUserStore = lazy("getUser", "getCurrentUser");
const getDispatcher = lazy("dispatch", "subscribe");
const getRestAPI = lazy("get", "post", "del", "patch");
const getGateway = lazy("getGateway", "send");
const getGuildStore = lazy("getGuildId", "getChannelId");

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;

const Dispatcher = findByProps("dispatch", "subscribe");
const RestAPI = findByProps("get", "post", "del", "patch");
const GatewayConnection = findByProps("getGateway", "send");
const SelectedGuildStore = findByProps("getGuildId", "getChannelId");

const MentionIcon = getAssetIDByName("ic_mention_24px") ??
    getAssetIDByName("MentionIcon") ??
    getAssetIDByName("mention");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const MENTION_REGEX = /<@!?(\d{17,19})>/g;

function extractIdsFromText(text: string): string[] {
    if (!text) return [];
    return [...text.matchAll(MENTION_REGEX)].map(x => x[1]).filter(id => !isUserCached(id));
}

function extractIdsFromComponents(components: any[]): string[] {
    const ids: string[] = [];
    if (!Array.isArray(components)) return ids;

    for (const component of components) {
        if (!component) continue;

        // Text Display component: { type: 10, content: "..." }
        if (component.type === 10 || typeof component.content === "string") {
            ids.push(...extractIdsFromText(component.content));
        }

        // Container / Section / Action Row etc. nest further components
        if (Array.isArray(component.components)) {
            ids.push(...extractIdsFromComponents(component.components));
        }
    }
    return ids;
}

function extractAllMentionIds(message: any): string[] {
    const ids: string[] = [];

    if (message.content) {
        ids.push(...extractIdsFromText(message.content));
    }

    if (message.embeds && Array.isArray(message.embeds)) {
        for (const embed of message.embeds) {
            if (embed.rawTitle) {
                ids.push(...extractIdsFromText(embed.rawTitle));
            }
            if (embed.rawDescription) {
                ids.push(...extractIdsFromText(embed.rawDescription));
            }
            if (embed.fields && Array.isArray(embed.fields)) {
                for (const field of embed.fields) {
                    if (field.rawName) ids.push(...extractIdsFromText(field.rawName));
                    if (field.rawValue) ids.push(...extractIdsFromText(field.rawValue));
                }
            }
        }
    }

    if (Array.isArray(message.components)) {
        ids.push(...extractIdsFromComponents(message.components));
    }

    // Forwarded messages - Discord stores them in messageSnapshots
    if (Array.isArray(message.messageSnapshots)) {
        for (const snapshot of message.messageSnapshots) {
            const snap = snapshot.message;
            if (snap) {
                if (snap.content) {
                    ids.push(...extractIdsFromText(snap.content));
                }
                if (snap.embeds && Array.isArray(snap.embeds)) {
                    for (const embed of snap.embeds) {
                        if (embed.rawTitle) {
                            ids.push(...extractIdsFromText(embed.rawTitle));
                        }
                        if (embed.rawDescription) {
                            ids.push(...extractIdsFromText(embed.rawDescription));
                        }
                        if (embed.fields && Array.isArray(embed.fields)) {
                            for (const field of embed.fields) {
                                if (field.rawName) ids.push(...extractIdsFromText(field.rawName));
                                if (field.rawValue) ids.push(...extractIdsFromText(field.rawValue));
                            }
                        }
                    }
                }
                if (Array.isArray(snap.components)) {
                    ids.push(...extractIdsFromComponents(snap.components));
                }
            }
        }
    }

    return [...new Set(ids)];
}

function isUserCached(userId: string): boolean {
    return !!getUserStore()?.getUser?.(userId);
}

function cloneComponents(components: any[]): any[] {
    for (const component of components) {
        if (!component) continue;
        if (component.type === 9 && component.accessory?.media) {
            component.accessory.media.proxyUrl = component.accessory.media.url;
            component.accessory.media.loadingState = 2;
        }
    }
    const clone = JSON.parse(JSON.stringify(components ?? []));

    function hasTextNodes(nodes: any[]): boolean {
        for (const node of nodes) {
            if (!node) continue;
            if (node.type === 10 || typeof node.content === "string") {
                node.content = node.content + "\u200b";
                return true;
            }
            if (Array.isArray(node.components) && hasTextNodes(node.components)) {
                return true;
            }
        }
        return false;
    }

    hasTextNodes(clone);
    return clone;
}

function hslaStringToInt(hsla: string): number {
    const match = hsla.match(
        /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)$/i
    );
    if (!match) return 1974050;

    const h = parseFloat(match[1]) / 360;
    const s = parseFloat(match[2]) / 100;
    const l = parseFloat(match[3]) / 100;

    if (s === 0) {
        const gray = Math.round(l * 255);
        return (gray << 16) | (gray << 8) | gray;
    }

    const hueToRgb = (p: number, q: number, t: number): number => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
    const g = Math.round(hueToRgb(p, q, h) * 255);
    const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);

    return (r << 16) | (g << 8) | b;
}

function normalizeEmbedColor(color: string | number | null | undefined): number {
    if (color === undefined || color === null) return 1974050;
    if (typeof color === "number") return color;
    if (typeof color === "string" && color.startsWith("hsl")) {
        return hslaStringToInt(color);
    }
    return 1974050;
}

function fillMedia(m: any) {
    if (m && typeof m.url === "string") {
        m.proxyUrl ??= m.url;
        m.loadingState ??= 2; // loaded?
    }
}

function buildComponents(src: any[], mark: boolean): any[] {
    const clone = JSON.parse(JSON.stringify(src ?? []));
    let marked = !mark;
    const walk = (nodes: any[]) => {
        for (const n of nodes) {
            if (!n) continue;
            fillMedia(n.media);
            fillMedia(n.file);
            n.items?.forEach((i: any) => fillMedia(i?.media));
            if (!marked && typeof n.content === "string") { n.content += "\u200b"; marked = true; }
            if (Array.isArray(n.components)) walk(n.components);
            if (n.accessory) walk([n.accessory]);
        }
    };
    walk(clone);
    return clone;
}

function toRawEmbed(embed: any): any {
    if (!embed) return embed;

    const raw: any = {
        type: embed.type,
        url: embed.url,
        color: normalizeEmbedColor(embed.color),
        timestamp: embed.timestamp,
        title: embed.rawTitle ?? (typeof embed.title === "string" ? embed.title : undefined),
        description: embed.rawDescription ?? (typeof embed.description === "string" ? embed.description : undefined),
        author: embed.author ? {
            name: embed.author.name,
            url: embed.author.url,
            icon_url: embed.author.iconURL,
            proxy_icon_url: embed.author.iconProxyURL
        } : undefined,
        image: embed.image ? {
            url: embed.image.url,
            proxy_url: embed.image.proxyURL,
            width: embed.image.width,
            height: embed.image.height,
        } : undefined,
        thumbnail: embed.thumbnail ? {
            url: embed.thumbnail.url,
            proxy_url: embed.thumbnail.proxyURL,
            width: embed.thumbnail.width,
            height: embed.thumbnail.height,
        } : undefined,
        video: embed.video,
        provider: embed.provider,
        footer: embed.footer ? {
            icon_url: embed.footer.iconURL,
            proxy_icon_url: embed.footer.iconProxyURL,
            ...embed.footer
        } : undefined,
    };

    if (Array.isArray(embed.fields)) {
        raw.fields = embed.fields.map((field: any) => ({
            name: field.rawName ?? (typeof field.name === "string" ? field.name : ""),
            value: field.rawValue ?? (typeof field.value === "string" ? field.value : ""),
            inline: field.inline,
        }));
    }

    return raw;
}

const IS_COMPONENTS_V2 = 1 << 15;

function hasComponentsV2Flag(flags: number | undefined): boolean {
    return typeof flags === "number" && (flags & IS_COMPONENTS_V2) === IS_COMPONENTS_V2;
}

async function forceUIRefresh(channelId: string, msg: any) {
    const freshContent = msg.content ? msg.content + "\u200b " : " ";
    const components = msg.components;
    const embeds = msg.embeds;
    const hasComponents = Array.isArray(components) && components.length > 0;
    const isCV2 = hasComponentsV2Flag(msg.flags);

    const Dispatcher = getDispatcher();
    const base = { id: msg.id, channel_id: channelId };
    if (hasComponentsV2Flag(msg.flags)) {
        const send = (mark: boolean) => Dispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: { ...base, flags: msg.flags, components: buildComponents(msg.components, mark) },
        });
        send(true);
        await sleep(1110);
        send(false);
        return;
    }

    const embeds = Array.isArray(msg.embeds) ? msg.embeds.map(toRawEmbed) : msg.embeds;
    Dispatcher.dispatch({ type: "MESSAGE_UPDATE",
        message: { ...base, content: msg.content ? msg.content + "\u200b" : " ", embeds } });
    await sleep(REFRESH_DELAY_MS);
    Dispatcher.dispatch({ type: "MESSAGE_UPDATE",
        message: { ...base, content: msg.content, embeds } });
}

async function fetchUsersViaGateway(userIds: string[]): Promise<boolean> {
    const SelectedGuildStore = getGuildStore();
    const currentGuildId = SelectedGuildStore?.getGuildId?.();
    if (!currentGuildId) return false;

    const GatewayConnection = getGateway();
    const ws = GatewayConnection?.getGateway?.();
    if (!ws) return false;

    try {
        ws.send(8, {
            guild_id: [currentGuildId],
            limit: 100,
            user_ids: userIds,
            presences: true
        });
    } catch (err) {
        logger.error("[ValidUser] Gateway send failed:", err);
        return false;
    }

    await sleep(400); 
    return true;
}

async function fetchUser(userId: string) {
    const Dispatcher = getDispatcher();
    const RestAPI = getRestAPI();
    let res;
    try {
        res = await RestAPI.get({ url: `/users/${userId}` });
    } catch (err: any) {
        if (err?.status !== 429) throw err;
        // error shape (status, body.retry_after in seconds) is a guess
        await sleep(Math.ceil((err.body?.retry_after ?? 1) * 1000));
        res = await RestAPI.get({ url: `/users/${userId}` });
    }
    if (res.body) {
        Dispatcher.dispatch({
            type: "USER_UPDATE",
            user: res.body
        });
        return res.body.username;
    }
    throw new Error("Empty API response body");
}

async function fixUnknownMentions(message: any) {
    const ids = extractAllMentionIds(message);
    if (ids.length === 0) return;

    const channelId = message.channelId || message.channel_id;
    const messageId = message.id;
    if (!channelId && !messageId) return;

    let uncachedIds = ids.filter(id => !isUserCached(id));
    if (uncachedIds.length === 0) {
        await forceUIRefresh(channelId, message);
        return;
    }

    const BULK_THRESHOLD = 5;
    if (uncachedIds.length > BULK_THRESHOLD && getGuildStore()?.getGuildId?.()) {
        await fetchUsersViaGateway(uncachedIds);
        // "request sent" is not "users fetched": re-check, REST-fetch the rest
        uncachedIds = uncachedIds.filter(id => !isUserCached(id));
    }

    if (uncachedIds.length > 0) {
        const safetyDelay = uncachedIds.length > 10 ? 900 : 250;

        for (let i = 0; i < uncachedIds.length; i++) {
            const userId = uncachedIds[i];
            try {
                await fetchUser(userId);
            } catch (err) {
                logger.error(`[ValidUser] Fetch Failed for ${userId}:`, err);
            }
            if (i < uncachedIds.length - 1) {
                await sleep(safetyDelay);
            }
        }
    }

    await forceUIRefresh(channelId, message);
    const joined = ids.map(x => `<@${x}>`).join(' ');
    try {
        messageUtil.sendBotMessage(channelId, `✅ ${joined} should be cached now.`);
    } catch(err) { pass; }
}

let unpatchOpenLazy: (() => void) | null = null;

const inFlight = new Set<string>();

async function runFix(message: any) {
    const key = message.id ?? "";
    if (inFlight.has(key)) return; // ignore double presses
    inFlight.add(key);
    try {
        await fixUnknownMentions(message);
        const missing = extractAllMentionIds(message).filter(id => !isUserCached(id)).length;
        showToast(missing ? `${missing} mention(s) still unresolved` : "Mentions refreshed");
    } catch (err) {
        logger.error("[ValidUser] Fix failed:", err);
        showToast("Failed to fix mentions");
    } finally {
        inFlight.delete(key);
    }
}

export default {
    onLoad() {
        if (!ActionSheet || !ActionSheetRow) {
            logger.error("[ValidUser] Required modules not found; plugin inactive.");
            return;
        }
        unpatchOpenLazy = before("openLazy", ActionSheet, ([comp, args, msg]) => {
            if (args !== "MessageLongPressActionSheet" || !msg?.message) return;

            const message = msg.message;
            const ids = extractAllMentionIds(message);

            if (ids.length === 0) return;

            comp.then((instance: any) => {
                const unpatch = after("default", instance, (_: any, component: any) => {
                    React.useEffect(() => () => { unpatch(); }, []);

                    const groups: any[] = findInReactTree(
                        component,
                        (c: any) => Array.isArray(c) && c[0]?.type?.name === "ActionSheetRowGroup"
                    );

                    if (!groups?.length) {
                        return;
                    }

                    const unknown = ids.filter(id => !isUserCached(id)).length;
                    const fixButton = React.createElement(ActionSheetRow, {
                        key: "valid-user-fix",
                        label: unknown === 0 ? "Refresh Mentions"
                            : unknown === 1 ? "Fix Unknown Mention"
                            : `Fix ${unknown} Unknown Mentions`,
                        icon: MentionIcon != null
                            ? React.createElement(ActionSheetRow.Icon, { source: MentionIcon })
                            : undefined,
                        onPress: () => {
                            ActionSheet.hideActionSheet();
                            runFix(message);
                        },
                    });

                    let inserted = false;
                    for (let gi = 0; gi < groups.length; gi++) {
                        const groupChildren: any[] = findInReactTree(
                            groups[gi],
                            (c: any) => Array.isArray(c) && c.some((child: any) =>
                                child?.type?.name === "ActionSheetRow"
                            )
                        );
                        if (!groupChildren) continue;

                        groupChildren.unshift(fixButton);
                        inserted = true;
                        break;
                    }

                    if (!inserted) {
                        groups.unshift(
                            React.createElement(ActionSheetRow.Group, null, fixButton)
                        );
                    }
                });
            }).catch((err: any) => {
                logger.error("[ValidUser] Failed to resolve action sheet component:", err);
            });
        });
    },

    onUnload() {
        unpatchOpenLazy?.();
        unpatchOpenLazy = null;
    },
};
