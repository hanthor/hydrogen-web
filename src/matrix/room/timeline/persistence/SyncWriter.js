/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventKey} from "../EventKey";
import {EventEntry} from "../entries/EventEntry.js";
import {FragmentBoundaryEntry} from "../entries/FragmentBoundaryEntry.js";
import {createEventEntry} from "./common.js";
import {EVENT_TYPE as MEMBER_EVENT_TYPE} from "../../members/RoomMember.js";

// Synapse bug? where the m.room.create event appears twice in sync response
// when first syncing the room
function deduplicateEvents(events) {
    const eventIds = new Set();
    return events.filter(e => {
        if (eventIds.has(e.event_id)) {
            return false;
        } else {
            eventIds.add(e.event_id);
            return true;
        }
    });
}

export class SyncWriter {
    constructor({roomId, fragmentIdComparer, memberWriter, relationWriter}) {
        this._roomId = roomId;
        this._memberWriter = memberWriter;
        this._relationWriter = relationWriter;
        this._fragmentIdComparer = fragmentIdComparer;
        this._lastLiveKey = null;
    }

    async load(txn, log) {
        const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
        if (liveFragment) {
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, liveFragment.id, 1);
            // fall back to the default event index in case the fragment was somehow written but no events
            // we should only create fragments when really writing timeline events now
            // (see https://github.com/vector-im/hydrogen-web/issues/112) but can't hurt to be extra robust.
            const eventIndex = lastEvent ? lastEvent.eventIndex : EventKey.defaultLiveKey.eventIndex;
            this._lastLiveKey = new EventKey(liveFragment.id, eventIndex);
        }
        // if there is no live fragment, we don't create it here because load gets a readonly txn.
        // this is on purpose, load shouldn't modify the store
        if (this._lastLiveKey) {
            log.set("live key", this._lastLiveKey.toString());
        }
    }

    async _createLiveFragment(txn, previousToken) {
        const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
        if (!liveFragment) {
            if (!previousToken) {
                previousToken = null;
            }
            const fragment = {
                roomId: this._roomId,
                id: EventKey.defaultLiveKey.fragmentId,
                previousId: null,
                nextId: null,
                previousToken: previousToken,
                nextToken: null
            };
            txn.timelineFragments.add(fragment);
            this._fragmentIdComparer.add(fragment);
            return fragment;
        } else {
            return liveFragment;
        }
    }

    async _replaceLiveFragment(oldFragmentId, newFragmentId, previousToken, txn) {
        const oldFragment = await txn.timelineFragments.get(this._roomId, oldFragmentId);
        if (!oldFragment) {
            throw new Error(`old live fragment doesn't exist: ${oldFragmentId}`);
        }
        oldFragment.nextId = newFragmentId;
        txn.timelineFragments.update(oldFragment);
        const newFragment = {
            roomId: this._roomId,
            id: newFragmentId,
            previousId: oldFragmentId,
            nextId: null,
            previousToken: previousToken,
            nextToken: null
        };
        txn.timelineFragments.add(newFragment);
        this._fragmentIdComparer.append(newFragmentId, oldFragmentId);
        return {oldFragment, newFragment};
    }

    /**
     * creates a new live fragment if the timeline is limited, or if no live fragment is created yet
     * @param  {EventKey} currentKey current key so far, might be none if room hasn't synced yet
     * @param  {Array<BaseEntrie>} entries    array to add fragment boundary entries when creating a new fragment
     * @param  {Object} timeline   timeline part of the room sync response
     * @param  {Transaction} txn        used to read and write from the fragment store
     * @return {EventKey} the new event key to start writing events at
     */
    async _ensureLiveFragment(currentKey, entries, timeline, txn, log) {
        if (!currentKey) {
            // means we haven't synced this room yet (just joined or did initial sync)
            
            // as this is probably a limited sync, prev_batch should be there
            // (but don't fail if it isn't, we won't be able to back-paginate though)
            let liveFragment = await this._createLiveFragment(txn, timeline.prev_batch);
            currentKey = new EventKey(liveFragment.id, EventKey.defaultLiveKey.eventIndex);
            entries.push(FragmentBoundaryEntry.start(liveFragment, this._fragmentIdComparer));
            log.log({l: "live fragment", first: true, id: currentKey.fragmentId});
        } else if (timeline.limited) {
            // replace live fragment for limited sync, *only* if we had a live fragment already
            const oldFragmentId = currentKey.fragmentId;
            currentKey = currentKey.nextFragmentKey();
            const {oldFragment, newFragment} = await this._replaceLiveFragment(oldFragmentId, currentKey.fragmentId, timeline.prev_batch, txn);
            entries.push(FragmentBoundaryEntry.end(oldFragment, this._fragmentIdComparer));
            entries.push(FragmentBoundaryEntry.start(newFragment, this._fragmentIdComparer));
            log.log({l: "live fragment", limited: true, id: currentKey.fragmentId});
        }
        return currentKey;
    }

    async _writeStateEvents(roomResponse, memberChanges, isLimited, txn, log) {
        // persist state
        const {state} = roomResponse;
        if (Array.isArray(state?.events)) {
            log.set("stateEvents", state.events.length);
            for (const event of state.events) {
                if (event.type === MEMBER_EVENT_TYPE) {
                    const memberChange = await this._memberWriter.writeStateMemberEvent(event, isLimited, txn);
                    if (memberChange) {
                        memberChanges.set(memberChange.userId, memberChange);
                    }
                } else {
                    txn.roomState.set(this._roomId, event);
                }
            }
        }
    }

    async _writeTimeline(timeline, currentKey, memberChanges, txn, log) {
        const entries = [];
        const updatedEntries = [];
        if (Array.isArray(timeline?.events) && timeline.events.length) {
            // only create a fragment when we will really write an event
            currentKey = await this._ensureLiveFragment(currentKey, entries, timeline, txn, log);
            const events = deduplicateEvents(timeline.events);
            log.set("timelineEvents", events.length);
            let timelineStateEventCount = 0;
            for(const event of events) {
                // store event in timeline
                currentKey = currentKey.nextKey();
                const storageEntry = createEventEntry(currentKey, this._roomId, event);
                let member = await this._memberWriter.lookupMember(event.sender, event, events, txn);
                if (member) {
                    storageEntry.displayName = member.displayName;
                    storageEntry.avatarUrl = member.avatarUrl;
                }
                txn.timelineEvents.insert(storageEntry);
                const entry = new EventEntry(storageEntry, this._fragmentIdComparer);
                entries.push(entry);
                const updatedRelationTargetEntries = await this._relationWriter.writeRelation(entry, txn, log);
                if (updatedRelationTargetEntries) {
                    updatedEntries.push(...updatedRelationTargetEntries);
                }
                // update state events after writing event, so for a member event,
                // we only update the member info after having written the member event
                // to the timeline, as we want that event to have the old profile info
                if (typeof event.state_key === "string") {
                    timelineStateEventCount += 1;
                    if (event.type === MEMBER_EVENT_TYPE) {
                        const memberChange = await this._memberWriter.writeTimelineMemberEvent(event, txn);
                        if (memberChange) {
                            memberChanges.set(memberChange.userId, memberChange);
                        }
                    } else {
                        txn.roomState.set(this._roomId, event);
                    }
                }
            }
            log.set("timelineStateEventCount", timelineStateEventCount);
        }
        return {currentKey, entries, updatedEntries};
    }

    async _handleRejoinOverlap(timeline, txn, log) {
        if (this._lastLiveKey) {
            const {fragmentId} = this._lastLiveKey;
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, fragmentId, 1);
            if (lastEvent) {
                const lastEventId = lastEvent.event.event_id;
                const {events} = timeline;
                const index = events.findIndex(event => event.event_id === lastEventId);
                if (index !== -1) {
                    log.set("overlap_event_id", lastEventId);
                    return Object.assign({}, timeline, {
                        limited: false,
                        events: events.slice(index + 1),
                    });
                }
            }
        }
        if (!timeline.limited) {
            log.set("force_limited_without_overlap", true);
            return Object.assign({}, timeline, {limited: true});
        }
        return timeline;
    }

    /**
     * @type {SyncWriterResult}
     * @property {Array<BaseEntry>} entries new timeline entries written
     * @property {EventKey} newLiveKey the advanced key to write events at
     * @property {Map<string, MemberChange>} memberChanges member changes in the processed sync ny user id
     * 
     * @param  {Object}  roomResponse [description]
     * @param  {boolean}  isRejoin whether the room was rejoined in the sync being processed
     * @param  {Transaction}  txn     
     * @return {SyncWriterResult}
     */
    async writeSync(roomResponse, isRejoin, txn, log) {
        let {timeline} = roomResponse;
        // we have rejoined the room after having synced it before,
        // check for overlap with the last synced event
        log.set("isRejoin", isRejoin);
        if (isRejoin) {
            timeline = await this._handleRejoinOverlap(timeline, txn, log);
        }
        const memberChanges = new Map();
        // important this happens before _writeTimeline so
        // members are available in the transaction
        await this._writeStateEvents(roomResponse, memberChanges, timeline?.limited, txn, log);
        const {currentKey, entries, updatedEntries} =
            await this._writeTimeline(timeline, this._lastLiveKey, memberChanges, txn, log);
        log.set("memberChanges", memberChanges.size);
        return {entries, updatedEntries, newLiveKey: currentKey, memberChanges};
    }

    afterSync(newLiveKey) {
        this._lastLiveKey = newLiveKey;
    }

    get lastMessageKey() {
        return this._lastLiveKey;
    }
}
