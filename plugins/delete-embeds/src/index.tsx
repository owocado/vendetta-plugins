import { findByProps } from "@vendetta/metro";
import { constants } from "@vendetta/metro/common";
import { after, before} from "@vendetta/patcher";
import { React } from "@vendetta/metro/common";
import { getAssetIDByName as getAssetId } from "@vendetta/ui/assets"
import { findInReactTree } from "@vendetta/utils"

let patches = [];

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const { ActionSheetRow } = findByProps("ActionSheetRow");
const { getCurrentUser } = findByProps("getCurrentUser")
const { suppressEmbeds } = findByProps("suppressEmbeds");
const Permissions = findByProps("getChannelPermissions", "can");
const { getChannel } = findByProps("getChannel");
const RestAPI = findByProps("patch", "get");

const EMBED_SUPPRESSED = 1 << 2;

function onLoad() {
    patches.push(before("openLazy", ActionSheet, ([component, key, msg]) => {
        const message = msg?.message;
        if (key != "MessageLongPressActionSheet" || !message) return;
        component.then(instance => {
            const unpatch = after("default", instance, (_, component) => {
                React.useEffect(() => () => { unpatch() }, [])
                const buttons = findInReactTree(
                    component,
                    c => c?.some?.(child => child?.type?.name === "ButtonRow" || child?.type?.name === "ActionSheetRow")
                );
                if (!buttons) return;

                const channel = getChannel(message.channel_id);
                const canManageMessages = Permissions.can(constants.Permissions.MANAGE_MESSAGES, channel);
                const hasPerms = getCurrentUser().id === message.author.id || canManageMessages;

                if (message.embeds.length !== 0 && hasPerms) {
                buttons.push(
                <ActionSheetRow
                    label="Suppress Embeds"
                    variant="danger"
                    icon={<ActionSheetRow.Icon source={getAssetId("ic_close_16px")} />}
                    onPress={() => {
                        suppressEmbeds(message.channel_id, message.id)
                        ActionSheet.hideActionSheet()
                    }}
                />)
                }

                const isEmbedSuppressed = (message.flags & EMBED_SUPPRESSED) !== 0;
                if (isEmbedSuppressed && hasPerms) {
                    buttons.push(
                    <ActionSheetRow
                        label="Unsuppress Embeds"
                        icon={<ActionSheetRow.Icon source={getAssetId("ic_image_24px")} />}
                        onPress={() => {
                            RestAPI.patch({
                                url: `/channels/${channel.id}/messages/${message.id}`,
                                body: { flags: message.flags & ~EMBED_SUPPRESSED }
                            });
                            ActionSheet.hideActionSheet();
                        }}
                    />)
                }
            })
        })
    }));
}

export default {
    onLoad,
    onUnload: () => {
        for (const unpatch of patches) {
            unpatch();
        };
    }
}
