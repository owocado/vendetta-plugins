/*!
 * Copyright 2023 Vendicated
 * 
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import { findByNameAll, findByProps } from "@vendetta/metro";
import { url as URLOpener } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const ActionShitter = findByProps("hideActionSheet");
const ups = [];

function walkReactTree(root: any, visit: (node: any) => void) {
    if (!root) return;

    visit(root);
    if (!root?.props?.children) return;

    if (Array.isArray(root.props.children)) {
        for (const child of root.props.children) {
            walkReactTree(child, visit);
        }
    } else {
        walkReactTree(root.props.children, visit);
    }
}

function trimExcessiveNewlines(text: string) {
    const pattern = new RegExp(`\\n{${4 + 1},}`, "g");
    return text.replace(pattern, "\n".repeat(2));
}

// WHY DOES DISCORD HAVE TWO OF THESE IM GONNA EXPLODE
for (const BioText of findByNameAll("BioText", false)) {
    // Patch the INPUT props before render, trimming the raw bio string.
    const beforeUp = before("default", BioText, (args) => {
        if (storage.trimNewlines === false) return;

        const props = args[0];
        if (!props) return;

        // Bio text is commonly passed as `bio` — adjust if Discord uses a
        // different key (log props once to confirm on your build).
        if (typeof props.bio === "string") {
            props.bio = trimExcessiveNewlines(props.bio);
        } else if (typeof props.children === "string") {
            props.children = trimExcessiveNewlines(props.children);
        }
    });

    const afterUp = after("default", BioText, (_, res) => {
        if (!res?.props?.children) return;

        walkReactTree(res, node => {
            if (node.props?.accessibilityRole === "link") {
                const url = node.props.children?.[0];
                if (typeof url !== "string") return;

                node.props.onPress = () => {
                    URLOpener.openURL(url);
                    if (storage.dismiss !== false)
                        ActionShitter.hideActionSheet();
                };
            }
        });
    });

    ups.push(beforeUp, afterUp);
}

export const onUnload = () => ups.forEach(up => up());

export { default as settings } from "./settings";
