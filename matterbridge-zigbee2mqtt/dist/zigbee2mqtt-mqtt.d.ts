/**
 * @file src/zigbee2mqtt.ts
 * @description This file contains the class Zigbee2MQTT and all the interfaces to communicate with zigbee2MQTT.
 * @author Luca Liguori
 * @created 2023-06-30
 * @version 3.1.0
 * @license Apache-2.0
 *
 * Copyright 2023, 2024, 2025, 2026, 2027 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { EventEmitter } from 'node:events';
import { LogLevel } from 'node-ansi-logger';
import type { Payload } from './payloadTypes.js';
import type { BridgeDevice, BridgeGroup, BridgeInfo } from './zigbee2mqttTypes.js';
export declare class Zigbee2MQTT extends EventEmitter {
    private log;
    mqttHost: string;
    mqttPort: number;
    mqttTopic: string;
    mqttUsername: string | undefined;
    mqttPassword: string | undefined;
    private mqttClient;
    private mqttIsConnected;
    private mqttIsReconnecting;
    private mqttIsEnding;
    private mqttDataPath;
    private mqttPublishQueue;
    private mqttPublishQueueTimeout;
    private mqttPublishInflights;
    private mqttKeepaliveInterval;
    private z2mIsAvailabilityEnabled;
    private z2mIsOnline;
    private z2mPermitJoin;
    private z2mPermitJoinTimeout;
    private z2mVersion;
    z2mBridge?: BridgeInfo;
    z2mDevices: BridgeDevice[];
    z2mGroups: BridgeGroup[];
    loggedBridgePayloads: number;
    loggedPublishPayloads: number;
    private options;
    /**
     * Creates a new Zigbee2MQTT instance.
     *
     * @param {string} mqttHost - The MQTT broker URL (e.g., 'mqtt://localhost' or 'mqtts://host' or 'mqtt+unix:///path'). Use 'mqtts://' for secure (TLS) connections.
     * @param {number} mqttPort - The MQTT broker port (default: 1883 for MQTT, 8883 for MQTT over TLS).
     * @param {string} mqttTopic - The base MQTT topic to subscribe to (e.g., 'zigbee2mqtt').
     * @param {string} [mqttUsername] - Optional username for MQTT authentication.
     * @param {string} [mqttPassword] - Optional password for MQTT authentication.
     * @param {string} [mqttClientId] - Optional client identifier for MQTT connection. If not set, a random client id will be generated.
     * @param {3 | 4 | 5} [protocolVersion] - MQTT protocol version (3, 4, or 5). Default is 5.
     * @param {string} [ca] - Path to a CA certificate file for verifying the MQTT broker when using 'mqtts://'. Required for secure connections.
     * @param {boolean} [rejectUnauthorized] - If true, only accept server certificates signed by a trusted CA. Set to false to allow self-signed/untrusted certs (not recommended).
     * @param {string} [cert] - Path to a client certificate file for mutual TLS authentication (optional, only needed if the broker requires client certificates).
     * @param {string} [key] - Path to a client private key file for mutual TLS authentication (optional, only needed if the broker requires client certificates).
     * @param {boolean} [debug] - Enable debug logging.
     *
     * @throws {Error} If 'mqtts://' is used but no CA certificate is provided.
     *
     * TLS usage notes:
     * - For secure MQTT (TLS), use 'mqtts://' in mqttHost and provide the 'ca' parameter.
     * - 'cert' and 'key' are only required if your broker requires client certificate authentication (mutual TLS).
     * - 'rejectUnauthorized' should almost always be true for security; set to false only for testing with self-signed certs.
     */
    constructor(mqttHost: string, mqttPort: number, mqttTopic: string, mqttUsername?: string, mqttPassword?: string, mqttClientId?: string, protocolVersion?: 3 | 4 | 5, ca?: string, rejectUnauthorized?: boolean, cert?: string, key?: string, debug?: boolean);
    /**
     * Set the log level to DEBUG or INFO.
     *
     * @param {boolean} logDebug - If true, set log level to DEBUG; otherwise, set to INFO.
     */
    setLogDebug(logDebug: boolean): void;
    /**
     * Set the log level.
     *
     * @param {LogLevel} logLevel - The desired log level.
     */
    setLogLevel(logLevel: LogLevel): void;
    /**
     * Set the data path.
     *
     * @param {string} dataPath - The desired data path.
     */
    setDataPath(dataPath: string): void;
    /**
     * Get the URL for the MQTT connection.
     *
     * @returns {string} The MQTT connection URL.
     */
    getUrl(): string;
    /**
     * Start the MQTT connection.
     */
    start(): void;
    /**
     * Stop the MQTT connection.
     */
    stop(): void;
    /**
     * Subscribe to a topic.
     *
     * @param {string} topic - The MQTT topic to subscribe to.
     */
    subscribe(topic: string): void;
    /**
     * Publish a message to a topic.
     *
     * @param {string} topic - The MQTT topic to publish to.
     * @param {string} message - The message to publish.
     * @param {boolean} [queue] - Whether to queue the message if the client is not connected. Default is false.
     */
    publish(topic: string, message: string, queue?: boolean): void;
    /**
     * Write a buffer to a JSON file.
     *
     * @param {string} file - The name of the file to write to.
     * @param {Buffer} buffer - The buffer containing the data to write.
     */
    private writeBufferJSON;
    /**
     * Write data to a file.
     *
     * @param {string} file - The name of the file to write to.
     * @param {string} data - The data to write.
     */
    private writeFile;
    /**
     * Tries to parse a JSON string.
     *
     * @param {string} text - The JSON string to parse.
     * @returns {any} - The parsed JSON object or an empty object on error.
     */
    private tryJsonParse;
    /**
     * Handle incoming MQTT messages.
     *
     * @param {string} topic - The MQTT topic the message was received on.
     * @param {Buffer} payload - The message payload.
     */
    private messageHandler;
    /**
     * Handle incoming device messages.
     *
     * @param {BridgeDevice} device - The device the message is for.
     * @param {string} entity - The entity ID.
     * @param {string} service - The service type.
     * @param {Buffer} payload - The message payload.
     */
    private handleDeviceMessage;
    private handleGroupMessage;
    /**
     * Handle incoming network map responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseNetworkmap;
    /**
     * Handle incoming device rename responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseDeviceRename;
    /**
     * Handle incoming device remove responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseDeviceRemove;
    /**
     * Handle incoming device options responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseDeviceOptions;
    /**
     * Handle incoming group add responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseGroupAdd;
    /**
     * Handle incoming group remove responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseGroupRemove;
    /**
     * Handle incoming group rename responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseGroupRename;
    /**
     * Handle incoming group add member responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseGroupAddMember;
    /**
     * Handle incoming group remove member responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponseGroupRemoveMember;
    /**
     * Handle incoming permit join responses.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleResponsePermitJoin;
    /**
     * Handle incoming event messages.
     *
     * @param {Buffer} payload - The message payload.
     */
    private handleEvent;
    /**
     * Read JSON config from a file.
     *
     * @param {string} filename - The name of the file to read from.
     * @returns {object|null} The parsed JSON object or null if an error occurred.
     */
    readConfig(filename: string): object | null;
    /**
     * Write JSON config to a file.
     *
     * @param {string} filename - The name of the file to write to.
     * @param {object} data - The JSON data to write.
     * @returns {boolean} True if the write was successful, false otherwise.
     */
    writeConfig(filename: string, data: object): boolean;
    /**
     * Emit a payload event for a specific entity.
     *
     * @param {string} entity - The entity ID.
     * @param {Payload} data - The payload data.
     */
    emitPayload(entity: string, data: Payload): void;
}
//# sourceMappingURL=zigbee2mqtt-mqtt.d.ts.map