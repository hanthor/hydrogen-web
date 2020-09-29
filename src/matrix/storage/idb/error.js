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

import { StorageError } from "../common.js";

export class IDBError extends StorageError {
    constructor(message, source, cause) {
        const storeName = source?.name || "<unknown store>";
        const databaseName = source?.transaction?.db?.name || "<unknown db>";
        let fullMessage = `${message} on ${databaseName}.${storeName}`;
        if (cause) {
            fullMessage += ": ";
            if (typeof cause.name === "string") {
                fullMessage += `(name: ${cause.name}) `;
            }
            if (typeof cause.code === "number") {
                fullMessage += `(code: ${cause.code}) `;
            }
        }
        if (cause) {
            fullMessage += cause.message;
        }
        super(fullMessage, cause);
        this.storeName = storeName;
        this.databaseName = databaseName;
    }
}

export class IDBRequestError extends IDBError {
    constructor(request) {
        const source = request?.source;
        const cause = request.error;
        super(`IDBRequest failed`, source, cause);
    }
}

export class IDBRequestAttemptError extends IDBError {
    constructor(method, source, cause, params) {
        super(`${method}(${params.map(p => JSON.stringify(p)).join(", ")}) failed`, source, cause);
    }
}
