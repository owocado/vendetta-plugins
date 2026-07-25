import { findByProps } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
import { logger } from "@vendetta";
import { React } from "@vendetta/metro/common";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const { ActionSheetRow } = findByProps("ActionSheetRow");

const UserStore = findByProps("getUser", "getCurrentUser");
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
    return [...text.matchAll(MENTION_REGEX)].map(x => x[1]);
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
            if (embed.title) {
                ids.push(...extractIdsFromText(embed.title));
            }
            if (embed.description) {
                ids.push(...extractIdsFromText(embed.description));
            }
            if (embed.fields && Array.isArray(embed.fields)) {
                for (const field of embed.fields) {
                    if (field.name) ids.push(...extractIdsFromText(field.name));
                    if (field.value) ids.push(...extractIdsFromText(field.value));
                }
            }
        }
    }

    if (Array.isArray(message.components)) {
        ids.push(...extractIdsFromComponents(message.components));
    }

    return [...new Set(ids)];
}

function isUserCached(userId: string): boolean {
    const user = UserStore?.getUser?.(userId);
    return !!user;
}

function cloneComponents(components: any[]): any[] {
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

async function forceUIRefresh(channelId: string, message: any) {
    const freshContent = message.content ? message.content + " " : " ";
    const hasComponents = Array.isArray(message.components) && message.components.length > 0;
    const comps = hasComponents ? cloneComponents(message.components) : message.components;

    // Dispatch slight variance update while preserving original embeds array
    Dispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: {
            id: message.id,
            channel_id: channelId,
            content: freshContent,
            embeds: message.embeds,
            components: comps,
            flags: message.flags
        }
    });

    await sleep(500);

    // Dispatch original layout state to settle the visual cache
    Dispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: {
            id: message.id,
            channel_id: channelId,
            content: message.content,
            embeds: message.embeds,
            components: comps,
            flags: message.flags
        }
    });
}

async function fetchUsersViaGateway(userIds: string[]): Promise<boolean> {
    const currentGuildId = SelectedGuildStore?.getGuildId?.();
    if (!currentGuildId) return false;

    const ws = GatewayConnection?.getGateway?.();
    if (!ws) return false;

    try {
        ws.send(8, {
            guild_id: currentGuildId,
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
    const res = await RestAPI.get({ url: `/users/${userId}` });
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
    const channelId = message.channel_id;
    const messageId = message.id;

    if (ids.length === 0) return;

    const uncachedIds: string[] = [];
    for (const userId of ids) {
        if (!isUserCached(userId)) {
            uncachedIds.push(userId);
        }
    }

    if (uncachedIds.length === 0) {
        if (channelId && messageId) {
            await forceUIRefresh(channelId, message);
        }
        return;
    }

    const BULK_THRESHOLD = 5;
    let success = false;

    if (uncachedIds.length > BULK_THRESHOLD && SelectedGuildStore?.getGuildId?.()) {
        success = await fetchUsersViaGateway(uncachedIds);
    }

    if (!success) {
        const safetyDelay = uncachedIds.length > 10 ? 450 : 250;

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

    if (channelId && messageId) {
        await forceUIRefresh(channelId, message);
    }
}

let unpatchOpenLazy: (() => void) | null = null;

export default {
    onLoad() {
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

                    const fixButton = React.createElement(ActionSheetRow, {
                        label: ids.length === 1 ? "Fix Unknown Mention" : `Fix ${ids.length} Unknown Mentions`,
                        icon: React.createElement(ActionSheetRow.Icon, {
                            source: MentionIcon,
                        }),
                        onPress: () => {
                            ActionSheet.hideActionSheet();
                            fixUnknownMentions(message);
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
