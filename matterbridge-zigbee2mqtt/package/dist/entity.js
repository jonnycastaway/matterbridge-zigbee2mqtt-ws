import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { airQualitySensor, bridgedNode, colorDimmerSwitch, colorTemperatureLight, contactSensor, dimmableLight, dimmablePlugInUnit, dimmerSwitch, doorLock, electricalSensor, extendedColorLight, genericSwitch, humiditySensor, lightSensor, MatterbridgeEndpoint, occupancySensor, onOffLight, onOffLightSwitch, onOffPlugInUnit, powerSource, pressureSensor, rainSensor, smokeCoAlarm, temperatureSensor, thermostat, waterLeakDetector, windowCovering, } from 'matterbridge';
import { AnsiLogger, CYAN, db, debugStringify, dn, gn, hk, idn, ign, nf, or, rs, YELLOW, zb } from 'matterbridge/logger';
import { CommonNumberTag, SwitchesTag } from 'matterbridge/matter';
import { AirQuality, BooleanState, BridgedDeviceBasicInformation, CarbonDioxideConcentrationMeasurement, CarbonMonoxideConcentrationMeasurement, ColorControl, DoorLock, ElectricalEnergyMeasurement, ElectricalPowerMeasurement, FormaldehydeConcentrationMeasurement, Identify, IlluminanceMeasurement, LevelControl, OccupancySensing, OnOff, Pm1ConcentrationMeasurement, Pm10ConcentrationMeasurement, Pm25ConcentrationMeasurement, PowerSource, PressureMeasurement, RelativeHumidityMeasurement, SmokeCoAlarm, TemperatureMeasurement, Thermostat, TotalVolatileOrganicCompoundsConcentrationMeasurement, WindowCovering, } from 'matterbridge/matter/clusters';
import { ClusterId, getClusterNameById } from 'matterbridge/matter/types';
import { deepCopy, deepEqual, fireAndForget, isValidArray, isValidNumber, isValidObject, kelvinToRGB, miredToKelvin, xyColorToRgbColor, xyToHsl } from 'matterbridge/utils';
export class ZigbeeEntity extends EventEmitter {
    log;
    serial = '';
    platform;
    device;
    group;
    entityName = '';
    isDevice = false;
    isGroup = false;
    actions = [];
    en = '';
    ien = '';
    bridgedDevice;
    eidn = or;
    lastPayload = {};
    lastSeen = 0;
    ignoreFeatures = [];
    transition = false;
    propertyMap = new Map();
    mutableDevice = new Map();
    cachePayload = {};
    cachePublishTimeout = undefined;
    cachePublishTimeoutTime = 100;
    noUpdateTimeout = undefined;
    noUpdateTimeoutTime = 2000;
    thermostatTimeout = undefined;
    thermostatTimeoutTime = 5000;
    composedType = '';
    hasEndpoints = false;
    isRouter = false;
    noUpdate = false;
    thermostatSystemModeLookup = ['off', 'auto', '', 'cool', 'heat', '', '', 'fan_only'];
    constructor(platform, entity) {
        super();
        this.platform = platform;
        if (this.isValidDevice(entity)) {
            this.device = entity;
            this.entityName = entity.friendly_name;
            this.isDevice = true;
            this.en = dn;
            this.ien = idn;
        }
        if (this.isValidGroup(entity)) {
            this.group = entity;
            this.entityName = entity.friendly_name;
            this.isGroup = true;
            this.en = gn;
            this.ien = ign;
        }
        this.log = new AnsiLogger({
            logName: this.entityName,
            logTimestampFormat: 4,
            logLevel: platform.config.debug ? "debug" : platform.log.logLevel,
        });
        this.log.debug(`Created MatterEntity: ${this.entityName}`);
        this.platform.z2m.on('MESSAGE-' + this.entityName, (payload) => {
            const now = Date.now();
            if (now - this.lastSeen < 1000 * 60 &&
                deepEqual(this.lastPayload, payload, ['linkquality', 'last_seen', ...this.ignoreFeatures]) &&
                !Object.prototype.hasOwnProperty.call(this.lastPayload, 'action')) {
                this.log.debug(`Skipping not changed ${platform.z2mDevicesRegistered ? 'MQTT message' : 'State update'} for accessory ${this.entityName}`);
                return;
            }
            this.lastSeen = Date.now();
            if (deepEqual(this.lastPayload, payload, this.ignoreFeatures))
                return;
            this.lastPayload = deepCopy(payload);
            if (Object.prototype.hasOwnProperty.call(this.lastPayload, 'action'))
                delete this.lastPayload.action;
            for (const key of this.ignoreFeatures) {
                if (Object.prototype.hasOwnProperty.call(payload, key)) {
                    delete payload[key];
                    this.log.debug(`Removed key ${CYAN}${key}${db} from payload`);
                }
            }
            if (this.bridgedDevice === undefined) {
                this.log.debug(`Skipping (no device) ${platform.z2mDevicesRegistered ? 'MQTT message' : 'State update'} for accessory ${this.entityName}`);
                return;
            }
            if (this.noUpdate) {
                this.log.debug(`Skipping (no update) ${platform.z2mDevicesRegistered ? 'MQTT message' : 'State update'} for accessory ${this.entityName}`);
                return;
            }
            if ('state' in payload && payload.state === 'OFF') {
                this.log.debug(`*Skipping color attributes update (state is OFF) ${platform.z2mDevicesRegistered ? 'MQTT message' : 'State update'} for accessory ${this.entityName}`);
                for (const key of Object.keys(payload)) {
                    if (['brightness', 'color_temp', 'color', 'color_mode'].includes(key))
                        delete payload[key];
                }
            }
            this.log.info(`${db}${platform.z2mDevicesRegistered ? 'MQTT message' : 'State update'} for device ${this.ien}${this.entityName}${rs}${db} payload: ${debugStringify(payload)}`);
            Object.entries(payload).forEach(([key, value]) => {
                if (value === undefined || value === null)
                    return;
                if (this.bridgedDevice === undefined)
                    return;
                if (key === 'voltage' && this.isDevice && this.device?.power_source === 'Battery')
                    key = 'battery_voltage';
                if (key === 'battery' && !('battery_low' in payload) && isValidNumber(value, 0, 100) && this.isDevice && this.device?.power_source === 'Battery') {
                    if (value < 20) {
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, PowerSource.id, 'batChargeLevel', PowerSource.BatChargeLevel.Critical);
                    }
                    else if (value < 40) {
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, PowerSource.id, 'batChargeLevel', PowerSource.BatChargeLevel.Warning);
                    }
                    else {
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, PowerSource.id, 'batChargeLevel', PowerSource.BatChargeLevel.Ok);
                    }
                }
                const propertyMap = this.propertyMap.get(key);
                if (propertyMap) {
                    this.log.debug(`Payload entry ${CYAN}${key}${db} => name: ${CYAN}${propertyMap.name}${db} type: ${CYAN}${propertyMap.type === '' ? 'generic' : propertyMap.type}${db} ` +
                        `endpoint: ${CYAN}${propertyMap.endpoint === '' ? 'main' : propertyMap.endpoint}${db}`);
                    let z2m;
                    z2m = z2ms.find((z2m) => z2m.type === propertyMap?.type && z2m.property === propertyMap?.name);
                    z2m ??= z2ms.find((z2m) => z2m.property === propertyMap?.name);
                    if (z2m) {
                        if (z2m.valueLookup && propertyMap.values && propertyMap.values !== '' && typeof value === 'string' && !propertyMap.values.includes(value)) {
                            this.log.debug(`*Payload entry ${CYAN}${key}${db} value ${CYAN}${value}${db} not found in propertyMap values ${CYAN}${propertyMap.values}${db}`);
                            return;
                        }
                        if (z2m.converter || z2m.valueLookup) {
                            this.updateAttributeIfChanged(this.bridgedDevice, propertyMap === undefined || propertyMap.endpoint === '' ? undefined : propertyMap.endpoint, z2m.cluster, z2m.attribute, z2m.converter ? z2m.converter(value) : value, z2m.valueLookup);
                            return;
                        }
                    }
                    else
                        this.log.debug(`*Payload entry ${CYAN}${key}${db} not found in zigbeeToMatter converter`);
                }
                else
                    this.log.debug(`*Payload entry ${CYAN}${key}${db} not found in propertyMap`);
                if (key === 'action' && typeof value === 'string' && value !== '') {
                    const propertyMap = this.propertyMap.get('action_' + value);
                    if (propertyMap) {
                        const child = this.bridgedDevice.getChildEndpointById(propertyMap.endpoint);
                        if (child?.maybeNumber)
                            fireAndForget(child.triggerSwitchEvent(propertyMap.action, this.log), this.log, `Error triggering switch event ${propertyMap.action} on ${propertyMap.endpoint}`);
                    }
                    else
                        this.log.debug(`*Payload entry ${CYAN}${'action_' + value}${db} not found in propertyMap`);
                }
                if (key === 'position' && this.isDevice && isValidNumber(value, 0, 100)) {
                    this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'currentPositionLiftPercent100ths', value * 100);
                }
                if (key === 'moving' && this.isDevice) {
                    if (value === 'UP') {
                        const status = WindowCovering.MovementStatus.Opening;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                    }
                    else if (value === 'DOWN') {
                        const status = WindowCovering.MovementStatus.Closing;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                    }
                    else if (value === 'STOP') {
                        const status = WindowCovering.MovementStatus.Stopped;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                        const position = this.bridgedDevice.getAttribute(WindowCovering.id, 'currentPositionLiftPercent100ths', this.log);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'currentPositionLiftPercent100ths', position);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'targetPositionLiftPercent100ths', position);
                    }
                }
                if (key === 'motor_state' && this.isDevice) {
                    if (value === 'opening') {
                        const status = WindowCovering.MovementStatus.Opening;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                    }
                    else if (value === 'closing') {
                        const status = WindowCovering.MovementStatus.Closing;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                    }
                    else if (value === 'stopped') {
                        const status = WindowCovering.MovementStatus.Stopped;
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'operationalStatus', { global: status, lift: status, tilt: status });
                        const position = this.bridgedDevice.getAttribute(WindowCovering.id, 'currentPositionLiftPercent100ths', this.log);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'currentPositionLiftPercent100ths', position);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, WindowCovering.id, 'targetPositionLiftPercent100ths', position);
                    }
                }
                if (key === 'current_heating_setpoint' && 'system_mode' in payload && payload['system_mode'] === 'heat' && isValidNumber(value)) {
                    this.updateAttributeIfChanged(this.bridgedDevice, undefined, Thermostat.id, 'occupiedHeatingSetpoint', value * 100);
                }
                if (key === 'current_heating_setpoint' && 'system_mode' in payload && payload['system_mode'] === 'cool' && isValidNumber(value)) {
                    this.updateAttributeIfChanged(this.bridgedDevice, undefined, Thermostat.id, 'occupiedCoolingSetpoint', value * 100);
                }
                if (key === 'color_temp' && 'color_mode' in payload && payload['color_mode'] === 'color_temp' && isValidNumber(value)) {
                    this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds);
                    const colorTemp = this.propertyMap.get('color_temp');
                    this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'colorTemperatureMireds', Math.max(colorTemp?.value_min ?? 147, Math.min(colorTemp?.value_max ?? 500, value)));
                }
                if (key === 'color' && 'color_mode' in payload && payload['color_mode'] === 'hs') {
                    const { hue, saturation } = value;
                    if (isValidNumber(hue, 0, 360) && isValidNumber(saturation, 0, 100)) {
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'currentHue', Math.round(hue / 360 * 254));
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'currentSaturation', Math.round(saturation / 100 * 254));
                    }
                }
                if (key === 'color' && 'color_mode' in payload && payload['color_mode'] === 'xy') {
                    const { x, y } = value;
                    if (isValidNumber(x, 0, 1) && isValidNumber(y, 0, 1)) {
                        const hsl = xyToHsl(x, y);
                        const rgb = xyColorToRgbColor(x, y);
                        this.log.debug(`ColorControl xyToHsl ${CYAN}${x}${db} ${CYAN}${y}${db} => h ${CYAN}${hsl.h}${db} s ${CYAN}${hsl.s}${db} l ${CYAN}${hsl.l}${db}`);
                        this.log.debug(`ColorControl xyToRgb ${CYAN}${x}${db} ${CYAN}${y}${db} => r ${CYAN}${rgb.r}${db} g ${CYAN}${rgb.g}${db} b ${CYAN}${rgb.b}${db}`);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'currentHue', Math.round(hsl.h / 360 * 254));
                        this.updateAttributeIfChanged(this.bridgedDevice, undefined, ColorControl.id, 'currentSaturation', Math.round(hsl.s / 100 * 254));
                    }
                }
            });
        });
        this.platform.z2m.on('ONLINE-' + this.entityName, () => {
            this.log.info(`ONLINE message for device ${this.ien}${this.entityName}${rs}`);
            const device = this.bridgedDevice;
            if (device?.maybeNumber !== undefined) {
                fireAndForget((async () => {
                    await device.setAttribute(BridgedDeviceBasicInformation.id, 'reachable', true, this.log);
                    await device.triggerEvent(BridgedDeviceBasicInformation.id, 'reachableChanged', { reachableNewValue: true }, this.log);
                })(), this.log, 'Error setting reachable online');
            }
        });
        this.platform.z2m.on('OFFLINE-' + this.entityName, () => {
            this.log.warn(`OFFLINE message for device ${this.ien}${this.entityName}${rs}`);
            const device = this.bridgedDevice;
            if (device?.maybeNumber !== undefined) {
                fireAndForget((async () => {
                    await device.setAttribute(BridgedDeviceBasicInformation.id, 'reachable', false, this.log);
                    await device.triggerEvent(BridgedDeviceBasicInformation.id, 'reachableChanged', { reachableNewValue: false }, this.log);
                })(), this.log, 'Error setting reachable offline');
            }
        });
    }
    destroy() {
        this.removeAllListeners();
        if (this.cachePublishTimeout)
            clearTimeout(this.cachePublishTimeout);
        this.cachePublishTimeout = undefined;
        if (this.thermostatTimeout)
            clearTimeout(this.thermostatTimeout);
        this.thermostatTimeout = undefined;
        if (this.noUpdateTimeout)
            clearTimeout(this.noUpdateTimeout);
        this.noUpdateTimeout = undefined;
        this.device = undefined;
        this.group = undefined;
        this.bridgedDevice = undefined;
        this.mutableDevice.clear();
        this.propertyMap.clear();
    }
    isValidDevice(entity) {
        return 'ieee_address' in entity;
    }
    isValidGroup(entity) {
        return 'id' in entity;
    }
    cachePublish(command = 'unknown', payload, transitionTime) {
        if (command === 'moveToColorTemperature') {
            delete this.cachePayload['color'];
        }
        else if (command === 'moveToColor' || command === 'moveToHueSaturation' || command === 'moveToHue' || command === 'moveToSaturation') {
            delete this.cachePayload['color_temp'];
        }
        if (payload)
            this.cachePayload = { ...this.cachePayload, ...payload };
        if (this.transition && transitionTime && transitionTime / 10 >= 0)
            this.cachePayload['transition'] = transitionTime / 10;
        clearTimeout(this.cachePublishTimeout);
        this.cachePublishTimeout = setTimeout(() => {
            clearTimeout(this.cachePublishTimeout);
            this.cachePublishTimeout = undefined;
            if (isValidObject(this.cachePayload, 1))
                this.publishCommand(command, (this.isGroup ? this.group?.friendly_name : this.device?.friendly_name), this.cachePayload);
            this.cachePayload = {};
            this.noUpdate = true;
            this.log.debug(`No update for 2 seconds to allow the device ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} to update its state`);
            clearTimeout(this.noUpdateTimeout);
            this.noUpdateTimeout = setTimeout(() => {
                clearTimeout(this.noUpdateTimeout);
                this.noUpdateTimeout = undefined;
                this.log.debug(`No update is now reset for the device ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db}`);
                this.noUpdate = false;
            }, this.noUpdateTimeoutTime).unref();
        }, this.cachePublishTimeoutTime).unref();
    }
    setCachePublishAttributes(endpoint, postfix) {
        const brightness = endpoint.hasAttributeServer(LevelControl.id, 'currentLevel') ? Math.round((endpoint.getAttribute(LevelControl.id, 'currentLevel') / 254) * 255) : undefined;
        if (isValidNumber(brightness, 1, 255))
            this.cachePayload['brightness' + (postfix ?? '')] = brightness;
        const color_temp = endpoint.hasClusterServer(ColorControl.id) &&
            endpoint.hasAttributeServer(ColorControl.id, 'colorTemperatureMireds') &&
            endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.ColorTemperatureMireds
            ? endpoint.getAttribute(ColorControl.id, 'colorTemperatureMireds')
            : undefined;
        if (isValidNumber(color_temp))
            this.cachePayload['color_temp' + (postfix ?? '')] = color_temp;
        const hs_color = endpoint.hasClusterServer(ColorControl.id) &&
            endpoint.hasAttributeServer(ColorControl.id, 'currentHue') &&
            endpoint.hasAttributeServer(ColorControl.id, 'currentSaturation') &&
            endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentHueAndCurrentSaturation
            ? [Math.round((endpoint.getAttribute(ColorControl.id, 'currentHue') / 254) * 360), Math.round((endpoint.getAttribute(ColorControl.id, 'currentSaturation') / 254) * 100)]
            : undefined;
        if (isValidArray(hs_color, 2)) {
            this.cachePayload['color' + (postfix ?? '')] = { h: hs_color[0], s: hs_color[1] };
        }
        const xy_color = endpoint.hasClusterServer(ColorControl.id) &&
            endpoint.hasAttributeServer(ColorControl.id, 'currentX') &&
            endpoint.hasAttributeServer(ColorControl.id, 'currentY') &&
            endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentXAndCurrentY
            ? [endpoint.getAttribute(ColorControl.id, 'currentX') / 65535, endpoint.getAttribute(ColorControl.id, 'currentY') / 65535]
            : undefined;
        if (isValidArray(xy_color, 2))
            this.cachePayload['color' + (postfix ?? '')] = { x: xy_color[0], y: xy_color[1] };
        const lookupColorMode = [
            'CurrentHueAndCurrentSaturation',
            'CurrentXAndCurrentY',
            'ColorTemperatureMireds',
            'EnhancedCurrentHueAndCurrentSaturation',
            'Brightness',
            'OnOff',
            'Unknown',
        ];
        let colorMode = 6;
        if (endpoint.hasClusterServer(ColorControl.id)) {
            colorMode = endpoint.getAttribute(ColorControl.id, 'colorMode');
        }
        else if (endpoint.hasClusterServer(LevelControl.id)) {
            colorMode = 4;
        }
        else if (endpoint.hasClusterServer(OnOff.id)) {
            colorMode = 5;
        }
        this.log.debug(`Set attributes called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} colorMode ${CYAN}${lookupColorMode[colorMode]}${db} payload ${debugStringify(this.cachePayload)}`);
    }
    saveCommands(command, data) {
        if (this.log.logLevel === "debug") {
            const filePath = path.join(this.platform.matterbridge.matterbridgePluginDirectory, this.platform.name, 'matter-commands.txt');
            fs.appendFileSync(filePath, `${new Date().toLocaleString()} - ` + data.endpoint.deviceName + ' ' + command + ' ' + JSON.stringify(data.request).replaceAll('\\"', '"') + '\n');
        }
    }
    onCommandHandler(data) {
        this.saveCommands('on', data);
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === true) {
            this.log.debug(`Command on ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} already ON`);
            return;
        }
        this.log.debug(`Command on called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.setCachePublishAttributes(data.endpoint, isChildEndpoint ? '_' + data.endpoint.id : undefined);
        this.cachePublish('on', { ['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: 'ON' });
    }
    offCommandHandler(data) {
        this.saveCommands('off', data);
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false) {
            this.log.debug(`Command off ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} already OFF`);
            return;
        }
        this.log.debug(`Command off called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('off', { ['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: 'OFF' });
    }
    toggleCommandHandler(data) {
        this.saveCommands('toggle', data);
        this.log.debug(`Command toggle called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false) {
            this.setCachePublishAttributes(data.endpoint, isChildEndpoint ? '_' + data.endpoint.id : undefined);
            this.cachePublish('toggle', { ['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: 'ON' });
        }
        else {
            this.cachePublish('toggle', { ['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: 'OFF' });
        }
    }
    moveToLevelCommandHandler(data) {
        this.saveCommands('moveToLevel', data);
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || data.endpoint.getAttribute(LevelControl.id, 'currentLevel') === data.request.level) {
            this.log.debug(`Command moveToLevel ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or level unchanged`);
            return;
        }
        this.log.debug(`Command moveToLevel called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.level} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('moveToLevel', { ['brightness' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: data.request.level }, data.request.transitionTime);
    }
    moveToLevelWithOnOffCommandHandler(data) {
        this.saveCommands('moveToLevelWithOnOff', data);
        this.log.debug(`Command moveToLevelWithOnOff called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.level} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        if (data.request['level'] <= (data.endpoint.getAttribute(LevelControl.id, 'minLevel') ?? 1)) {
            if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false) {
                this.log.debug(`*Command moveToLevelWithOnOff ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF`);
                return;
            }
            data.endpoint.log.debug(`Command moveToLevelWithOnOff received with level <= minLevel(${data.endpoint.getAttribute(LevelControl.id, 'minLevel')}) => turn off the light`);
            this.cachePublish('moveToLevelWithOnOff', { ['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: 'OFF' }, data.request.transitionTime);
        }
        else {
            if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false) {
                data.endpoint.log.debug(`Command moveToLevelWithOnOff received with level > minLevel(${data.endpoint.getAttribute(LevelControl.id, 'minLevel')}) and light is off => turn on the light with attributes`);
                this.cachePayload['state' + (isChildEndpoint ? '_' + data.endpoint.id : '')] = 'ON';
                this.setCachePublishAttributes(data.endpoint, isChildEndpoint ? '_' + data.endpoint.id : '');
            }
            this.cachePublish('moveToLevelWithOnOff', { ['brightness' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: data.request.level }, data.request.transitionTime);
        }
    }
    moveToColorTemperatureCommandHandler(data) {
        this.saveCommands('moveToColorTemperature', data);
        delete this.cachePayload['color'];
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || (this.propertyMap.get('color_temp') && data.endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.ColorTemperatureMireds && data.endpoint.getAttribute(ColorControl.id, 'colorTemperatureMireds') === data.request.colorTemperatureMireds)) {
            this.log.debug(`*Command moveToColorTemperature ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or colorTemperatureMireds unchanged`);
            return;
        }
        this.log.debug(`Command moveToColorTemperature called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.colorTemperatureMireds} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        if (this.propertyMap.get('color_temp')) {
            this.cachePublish('moveToColorTemperature', { ['color_temp' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: data.request.colorTemperatureMireds }, data.request.transitionTime);
        }
        else {
            const rgb = kelvinToRGB(miredToKelvin(data.request.colorTemperatureMireds));
            this.cachePublish('moveToColorTemperature', { ['color' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: { r: rgb.r, g: rgb.g, b: rgb.b } }, data.request.transitionTime);
            this.log.debug(`Command moveToColorTemperature called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} but color_temp property is not available. Converting ${data.request.colorTemperatureMireds} to RGB ${debugStringify(rgb)}.`);
        }
    }
    moveToColorCommandHandler(data) {
        this.saveCommands('moveToColor', data);
        delete this.cachePayload['color_temp'];
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || (data.endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentXAndCurrentY && data.endpoint.getAttribute(ColorControl.id, 'currentX') === data.request.colorX && data.endpoint.getAttribute(ColorControl.id, 'currentY') === data.request.colorY)) {
            this.log.debug(`Command moveToColor ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or color unchanged`);
            return;
        }
        this.log.debug(`Command moveToColor called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: X: ${data.request.colorX} Y: ${data.request.colorY} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('moveToColor', { ['color' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: { x: Math.round(data.request.colorX / 65536 * 10000) / 10000, y: Math.round(data.request.colorY / 65536 * 10000) / 10000 } }, data.request.transitionTime);
    }
    moveToHueCommandHandler(data) {
        this.saveCommands('moveToHue', data);
        delete this.cachePayload['color_temp'];
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || (data.endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentHueAndCurrentSaturation && data.endpoint.getAttribute(ColorControl.id, 'currentHue') === data.request.hue)) {
            this.log.debug(`Command moveToHue ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or hue unchanged`);
            return;
        }
        this.log.debug(`Command moveToHue called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.hue} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('moveToHue', { ['color' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: { h: Math.round(data.request.hue / 254 * 360), s: Math.round(data.endpoint.getAttribute(ColorControl.id, 'currentSaturation') / 254 * 100) } }, data.request.transitionTime);
    }
    moveToSaturationCommandHandler(data) {
        this.saveCommands('moveToSaturation', data);
        delete this.cachePayload['color_temp'];
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || (data.endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentHueAndCurrentSaturation && data.endpoint.getAttribute(ColorControl.id, 'currentSaturation') === data.request.saturation)) {
            this.log.debug(`Command moveToSaturation ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or saturation unchanged`);
            return;
        }
        this.log.debug(`Command moveToSaturation called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.saturation} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('moveToSaturation', { ['color' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: { h: Math.round(data.endpoint.getAttribute(ColorControl.id, 'currentHue') / 254 * 360), s: Math.round(data.request.saturation / 254 * 100) } }, data.request.transitionTime);
    }
    moveToHueAndSaturationCommandHandler(data) {
        this.saveCommands('moveToHueAndSaturation', data);
        delete this.cachePayload['color_temp'];
        if (data.endpoint.getAttribute(OnOff.id, 'onOff') === false || (data.endpoint.getAttribute(ColorControl.id, 'colorMode') === ColorControl.ColorMode.CurrentHueAndCurrentSaturation && data.endpoint.getAttribute(ColorControl.id, 'currentHue') === data.request.hue && data.endpoint.getAttribute(ColorControl.id, 'currentSaturation') === data.request.saturation)) {
            this.log.debug(`Command moveToHueAndSaturation ignored for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} light OFF or hue/saturation unchanged`);
            return;
        }
        this.log.debug(`Command moveToHueAndSaturation called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${data.endpoint?.maybeId}:${data.endpoint?.maybeNumber} request: ${data.request.hue} - ${data.request.saturation} transition: ${data.request.transitionTime}`);
        const isChildEndpoint = data.endpoint.deviceName !== this.entityName;
        this.cachePublish('moveToHueAndSaturation', { ['color' + (isChildEndpoint ? '_' + data.endpoint.id : '')]: { h: Math.round(data.request.hue / 254 * 360), s: Math.round(data.request.saturation / 254 * 100) } }, data.request.transitionTime);
    }
    addBridgedDeviceBasicInformation() {
        if (!this.bridgedDevice)
            throw new Error('No bridged device');
        const softwareVersion = Number.parseInt(this.platform.z2mBridgeInfo?.version || '1');
        const softwareVersionString = `${this.platform.z2mBridgeInfo?.version} (commit ${this.platform.z2mBridgeInfo?.commit})`;
        const hardwareVersion = Number.parseInt(this.platform.matterbridge.matterbridgeVersion || '1');
        const hardwareVersionString = this.platform.matterbridge.matterbridgeVersion || 'unknown';
        if (this.isDevice && this.device?.friendly_name === 'Coordinator') {
            this.bridgedDevice.createDefaultBridgedDeviceBasicInformationClusterServer(this.device.friendly_name, this.serial, 0xfff1, 'zigbee2MQTT', 'Coordinator', softwareVersion, softwareVersionString, hardwareVersion, hardwareVersionString);
        }
        else if (this.isDevice && this.device) {
            this.bridgedDevice.createDefaultBridgedDeviceBasicInformationClusterServer(this.device.friendly_name, this.serial, 0xfff1, this.device.definition ? this.device.definition.vendor : this.device.manufacturer, this.device.definition ? this.device.definition.model : this.device.model_id, softwareVersion, softwareVersionString, hardwareVersion, hardwareVersionString);
        }
        else if (this.isGroup && this.group) {
            this.bridgedDevice.createDefaultBridgedDeviceBasicInformationClusterServer(this.group.friendly_name, this.serial, 0xfff1, 'zigbee2MQTT', 'Group', softwareVersion, softwareVersionString, hardwareVersion, hardwareVersionString);
        }
        return this.bridgedDevice;
    }
    addPowerSource() {
        if (!this.bridgedDevice)
            throw new Error('No bridged device');
        if (this.isDevice) {
            if (this.device?.power_source === 'Battery') {
                this.bridgedDevice.createDefaultPowerSourceReplaceableBatteryClusterServer(100, PowerSource.BatChargeLevel.Ok);
            }
            else {
                this.bridgedDevice.createDefaultPowerSourceWiredClusterServer();
            }
        }
        if (this.isGroup) {
            this.bridgedDevice.createDefaultPowerSourceWiredClusterServer();
        }
        return this.bridgedDevice;
    }
    verifyMutableDevice(endpoint) {
        if (!endpoint)
            return false;
        for (const deviceType of endpoint.getDeviceTypes()) {
            for (const clusterId of deviceType.requiredServerClusters) {
                if (!endpoint.hasClusterServer(clusterId)) {
                    endpoint.addClusterServers([clusterId]);
                    this.log.warn(`Endpoint with device type ${deviceType.name} (0x${deviceType.code.toString(16)}) requires cluster server ${getClusterNameById(clusterId)} (0x${clusterId.toString(16)}) but it is not present on endpoint`);
                }
            }
        }
        for (const childEndpoint of endpoint.getChildEndpoints()) {
            for (const deviceType of childEndpoint.getDeviceTypes()) {
                for (const clusterId of deviceType.requiredServerClusters) {
                    if (!childEndpoint.hasClusterServer(clusterId)) {
                        childEndpoint.addClusterServers([clusterId]);
                        this.log.warn(`Child endpoint with device type ${deviceType.name} (0x${deviceType.code.toString(16)}) requires cluster server ${getClusterNameById(clusterId)} (0x${clusterId.toString(16)}) but it is not present on child endpoint`);
                    }
                }
            }
        }
        return true;
    }
    async configure() {
        if (this.bridgedDevice?.hasClusterServer(WindowCovering.id)) {
            this.log.info(`Configuring ${this.bridgedDevice?.deviceName} WindowCovering cluster`);
            await this.bridgedDevice?.setWindowCoveringTargetAsCurrentAndStopped();
        }
        if (this.bridgedDevice?.hasClusterServer(DoorLock.id)) {
            this.log.info(`Configuring ${this.bridgedDevice?.deviceName} DoorLock cluster`);
            const state = this.bridgedDevice?.getAttribute(DoorLock.id, 'lockState', this.log);
            if (this.bridgedDevice.maybeNumber) {
                if (state === DoorLock.LockState.Locked)
                    await this.bridgedDevice?.triggerEvent(DoorLock.id, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Lock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
                if (state === DoorLock.LockState.Unlocked)
                    await this.bridgedDevice?.triggerEvent(DoorLock.id, 'lockOperation', { lockOperationType: DoorLock.LockOperationType.Unlock, operationSource: DoorLock.OperationSource.Manual, userIndex: null, fabricIndex: null, sourceNode: null }, this.log);
            }
        }
        if (this.bridgedDevice?.hasClusterServer(ColorControl.id)) {
            this.log.info(`Configuring ${this.bridgedDevice?.deviceName} ColorControl cluster`);
            const colorTemp = this.propertyMap.get('color_temp');
            await this.bridgedDevice?.setAttribute(ColorControl.id, 'colorTempPhysicalMinMireds', colorTemp?.value_min ?? 147, this.log);
            await this.bridgedDevice?.setAttribute(ColorControl.id, 'colorTempPhysicalMaxMireds', colorTemp?.value_max ?? 500, this.log);
        }
    }
    updateAttributeIfChanged(deviceEndpoint, childEndpointName, clusterId, attributeName, value, lookup) {
        if (value === undefined)
            return;
        if (childEndpointName && childEndpointName !== '') {
            deviceEndpoint = this.bridgedDevice?.getChildEndpointById(childEndpointName) ?? deviceEndpoint;
        }
        if (!deviceEndpoint.hasClusterServer(ClusterId(clusterId))) {
            this.log.debug(`Update endpoint ${this.eidn}${deviceEndpoint.name}:${deviceEndpoint.number}${db}${childEndpointName ? ' (' + zb + childEndpointName + db + ')' : ''} cluster ${hk}${clusterId}${db}-${hk}${getClusterNameById(ClusterId(clusterId))}${db} not found: is z2m converter exposing all features?`);
            return;
        }
        if (!deviceEndpoint.hasAttributeServer(ClusterId(clusterId), attributeName)) {
            this.log.debug(`Update endpoint ${this.eidn}${deviceEndpoint.name}:${deviceEndpoint.number}${db}${childEndpointName ? ' (' + zb + childEndpointName + db + ')' : ''} error attribute ${hk}${clusterId}${db}-${hk}${getClusterNameById(ClusterId(clusterId))}${db}.${hk}${attributeName}${db} not found`);
            return;
        }
        if (lookup !== undefined) {
            if (typeof value === 'string' && lookup.indexOf(value) !== -1) {
                value = lookup.indexOf(value);
            }
            else {
                this.log.debug(`Update endpoint ${this.eidn}${deviceEndpoint.name}:${deviceEndpoint.name}:${deviceEndpoint.number}${db}${childEndpointName ? ' (' + zb + childEndpointName + db + ')' : ''} ` +
                    `attribute ${hk}${getClusterNameById(ClusterId(clusterId))}${db}.${hk}${attributeName}${db} value ${zb}${typeof value === 'object' ? debugStringify(value) : value}${db} not found in lookup ${debugStringify(lookup)}`);
                return;
            }
        }
        const localValue = deviceEndpoint.getAttribute(ClusterId(clusterId), attributeName);
        if (typeof value === 'object' ? deepEqual(value, localValue) : value === localValue) {
            this.log.debug(`Skip update endpoint ${deviceEndpoint.name}:${deviceEndpoint.maybeNumber}${childEndpointName ? ' (' + childEndpointName + ')' : ''} ` +
                `attribute ${getClusterNameById(ClusterId(clusterId))}.${attributeName} already ${typeof value === 'object' ? debugStringify(value) : value}`);
            return;
        }
        this.log.info(`${db}Update endpoint ${this.eidn}${deviceEndpoint.name}:${deviceEndpoint.maybeNumber}${db}${childEndpointName ? ' (' + zb + childEndpointName + db + ')' : ''} ` +
            `attribute ${hk}${getClusterNameById(ClusterId(clusterId))}${db}.${hk}${attributeName}${db} from ${YELLOW}${typeof localValue === 'object' ? debugStringify(localValue) : localValue}${db} to ${YELLOW}${typeof value === 'object' ? debugStringify(value) : value}${db}`);
        fireAndForget(deviceEndpoint.setAttribute(ClusterId(clusterId), attributeName, value), this.log, `Error setting attribute ${getClusterNameById(ClusterId(clusterId))}.${attributeName} to ${value}`);
    }
    publishCommand(command, entityName, payload) {
        this.log.debug(`PublishCommand ${command} called for ${this.ien}${entityName}${rs}${db} payload: ${debugStringify(payload)}`);
        if (entityName.startsWith('bridge/request')) {
            this.platform.publish(entityName, '', JSON.stringify(payload));
        }
        else {
            this.platform.publish(entityName, 'set', JSON.stringify(payload));
        }
    }
    logPropertyMap() {
        this.propertyMap.forEach((value, key) => {
            this.log.debug(`Property ${CYAN}${key}${db} name ${CYAN}${value.name}${db} type ${CYAN}${value.type === '' ? 'generic' : value.type}${db} endpoint ${CYAN}${value.endpoint === '' ? 'main' : value.endpoint}${db} ` +
                `category ${CYAN}${value.category}${db} description ${CYAN}${value.description}${db} label ${CYAN}${value.label}${db} unit ${CYAN}${value.unit}${db} ` +
                `values ${CYAN}${value.values}${db} value_min ${CYAN}${value.value_min}${db} value_max ${CYAN}${value.value_max}${db}`);
        });
    }
}
export class ZigbeeGroup extends ZigbeeEntity {
    constructor(platform, group) {
        super(platform, group);
    }
    static async create(platform, group) {
        const zigbeeGroup = new ZigbeeGroup(platform, group);
        if (zigbeeGroup.platform.postfix === '') {
            zigbeeGroup.serial = `group-${group.id}`.slice(0, 32);
        }
        else {
            zigbeeGroup.serial = `group-${group.id}-${zigbeeGroup.platform.postfix}`.slice(0, 32);
        }
        platform.setSelectDevice(`group-${group.id}`, group.friendly_name, 'wifi');
        let useState = false;
        let useBrightness = false;
        let useTransition = false;
        let useColor = false;
        let useColorTemperature = false;
        let minColorTemperature = 140;
        let maxColorTemperature = 500;
        let isSwitch = false;
        let isLight = false;
        let isCover = false;
        let isThermostat = false;
        if (group.members.length === 0) {
            zigbeeGroup.log.debug(`Group: ${gn}${group.friendly_name}${rs}${db} is a ${CYAN}virtual${db} group`);
            zigbeeGroup.bridgedDevice = new MatterbridgeEndpoint([onOffLightSwitch, bridgedNode, powerSource], { id: group.friendly_name }, zigbeeGroup.log.logLevel === "debug");
            zigbeeGroup.bridgedDevice.createDefaultOnOffClusterServer();
            isSwitch = true;
            zigbeeGroup.propertyMap.set('state', { name: 'state', type: 'switch', endpoint: '' });
        }
        else {
            group.members.forEach((member) => {
                const device = zigbeeGroup.platform.z2mBridgeDevices?.find((device) => device.ieee_address === member.ieee_address);
                if (!device)
                    return;
                zigbeeGroup.log.debug(`Group ${gn}${group.friendly_name}${db}: member device ${dn}${device.friendly_name}${db}`);
                device.definition?.exposes.forEach((expose) => {
                    if (expose.features) {
                        expose.features?.forEach((feature) => {
                            if (expose.type === 'lock' && feature.name === 'state' && feature.property === 'child_lock') {
                                expose.type = 'child_lock';
                                feature.name = 'child_lock';
                            }
                            zigbeeGroup.log.debug(`- specific type ${CYAN}${expose.type}${db}${feature.endpoint ? ' endpoint ' + CYAN + feature.endpoint + db : ''}${db} feature name ${CYAN}${feature.name}${db} property ${CYAN}${feature.property}${db} min ${CYAN}${feature.value_min}${db} max ${CYAN}${feature.value_max}${db}`);
                            if (expose.type === 'switch' || expose.type === 'light') {
                                if (expose.type === 'switch')
                                    isSwitch = true;
                                if (expose.type === 'light')
                                    isLight = true;
                                useState = useState || feature.name === 'state' ? true : false;
                                useBrightness = useBrightness || feature.name === 'brightness' ? true : false;
                                useColor = useColor || feature.property === 'color' ? true : false;
                                useColorTemperature = useColorTemperature || feature.name === 'color_temp' ? true : false;
                                if (feature.value_min)
                                    minColorTemperature = Math.min(minColorTemperature, feature.value_min);
                                if (feature.value_max)
                                    maxColorTemperature = Math.max(maxColorTemperature, feature.value_max);
                            }
                            else if (expose.type === 'cover') {
                                isCover = true;
                            }
                            else if (expose.type === 'climate') {
                                isThermostat = true;
                            }
                        });
                    }
                    else {
                        zigbeeGroup.log.debug(`- generic type ${CYAN}${expose.type}${db} expose name ${CYAN}${expose.name}${db} property ${CYAN}${expose.property}${db}`);
                    }
                });
                device.definition?.options.forEach((option) => {
                    useTransition = useTransition || option.name === 'transition' ? true : false;
                });
            });
            zigbeeGroup.log.debug(`Group ${gn}${group.friendly_name}${rs}${db} switch: ${CYAN}${isSwitch}${db} light: ${CYAN}${isLight}${db} cover: ${CYAN}${isCover}${db} thermostat: ${CYAN}${isThermostat}${db}`);
            zigbeeGroup.log.debug(`Group ${gn}${group.friendly_name}${rs}${db} state: ${CYAN}${useState}${db} brightness: ${CYAN}${useBrightness}${db} color: ${CYAN}${useColor}${db} color_temp: ${CYAN}${useColorTemperature}${db} min: ${CYAN}${minColorTemperature}${db} max: ${CYAN}${maxColorTemperature}${db}`);
            let deviceType;
            if (useState) {
                deviceType = onOffLight;
                if (platform.switchList.includes(group.friendly_name))
                    deviceType = onOffLightSwitch;
                else if (platform.lightList.includes(group.friendly_name))
                    deviceType = onOffLight;
                else if (platform.outletList.includes(group.friendly_name))
                    deviceType = onOffPlugInUnit;
                zigbeeGroup.propertyMap.set('state', { name: 'state', type: isLight ? 'light' : 'switch', endpoint: '' });
            }
            if (useBrightness) {
                deviceType = dimmableLight;
                zigbeeGroup.propertyMap.set('brightness', { name: 'brightness', type: 'light', endpoint: '' });
            }
            if (useTransition) {
                zigbeeGroup.transition = true;
            }
            if (useColorTemperature) {
                deviceType = colorTemperatureLight;
                zigbeeGroup.propertyMap.set('color_temp', { name: 'color_temp', type: 'light', endpoint: '' });
            }
            if (useColor) {
                deviceType = extendedColorLight;
                zigbeeGroup.propertyMap.set('color', { name: 'color', type: 'light', endpoint: '' });
            }
            if (isCover) {
                deviceType = windowCovering;
                zigbeeGroup.propertyMap.set('state', { name: 'state', type: 'cover', endpoint: '' });
                zigbeeGroup.propertyMap.set('position', { name: 'position', type: 'cover', endpoint: '' });
                zigbeeGroup.propertyMap.set('moving', { name: 'moving', type: 'cover', endpoint: '' });
            }
            if (isThermostat) {
                deviceType = thermostat;
                zigbeeGroup.propertyMap.set('local_temperature', { name: 'local_temperature', type: 'climate', endpoint: '' });
                zigbeeGroup.propertyMap.set('current_heating_setpoint', { name: 'current_heating_setpoint', type: 'climate', endpoint: '' });
                zigbeeGroup.propertyMap.set('current_cooling_setpoint', { name: 'current_cooling_setpoint', type: 'climate', endpoint: '' });
                zigbeeGroup.propertyMap.set('running_state', { name: 'running_state', type: 'climate', endpoint: '' });
                zigbeeGroup.propertyMap.set('system_mode', { name: 'system_mode', type: 'climate', endpoint: '' });
            }
            if (!deviceType)
                return zigbeeGroup;
            zigbeeGroup.bridgedDevice = new MatterbridgeEndpoint([deviceType, bridgedNode, powerSource], { id: group.friendly_name }, zigbeeGroup.log.logLevel === "debug");
            if (deviceType.code === onOffLightSwitch.code)
                zigbeeGroup.bridgedDevice.createDefaultOnOffClusterServer();
        }
        if (!platform.featureBlackList?.includes('scenes') && !platform.deviceFeatureBlackList[group.friendly_name]?.includes('scenes')) {
            for (const scene of group.scenes) {
                zigbeeGroup.log.debug(`***Group ${gn}${group.friendly_name}${rs}${db} scene ${CYAN}${scene.name}${db} id ${CYAN}${scene.id}${db}`);
                platform.setSelectDeviceEntity(`group-${group.id}`, 'scenes', 'Scenes', 'component');
                await platform.registerVirtualDevice(`${platform.config.scenesPrefix ? group.friendly_name + ' ' : ''}${scene.name}`, platform.config.scenesType, async () => {
                    zigbeeGroup.log.info(`Triggered scene "${scene.name}" id ${scene.id} from group ${group.friendly_name}`);
                    zigbeeGroup.publishCommand('scene_recall', group.friendly_name, { scene_recall: scene.id });
                });
            }
        }
        zigbeeGroup.addBridgedDeviceBasicInformation();
        zigbeeGroup.addPowerSource();
        zigbeeGroup.bridgedDevice.addRequiredClusters();
        if (!zigbeeGroup.bridgedDevice || !zigbeeGroup.verifyMutableDevice(zigbeeGroup.bridgedDevice))
            return zigbeeGroup;
        zigbeeGroup.mutableDevice.clear();
        zigbeeGroup.logPropertyMap();
        if (isSwitch || isLight) {
            if (isSwitch && !isLight)
                await zigbeeGroup.bridgedDevice.addFixedLabel('type', 'switch');
            if (isLight)
                await zigbeeGroup.bridgedDevice.addFixedLabel('type', 'light');
            zigbeeGroup.bridgedDevice.addCommandHandler('identify', ({ request: { identifyTime } }) => {
                zigbeeGroup.log.debug(`Command identify called for ${zigbeeGroup.ien}${group.friendly_name}${rs}${db} identifyTime:${identifyTime}`);
            });
            if (zigbeeGroup.bridgedDevice.hasClusterServer(OnOff.id)) {
                zigbeeGroup.bridgedDevice.addCommandHandler('on', zigbeeGroup.onCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('off', zigbeeGroup.offCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('toggle', zigbeeGroup.toggleCommandHandler.bind(zigbeeGroup));
            }
        }
        if (isLight) {
            if (useBrightness) {
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToLevel', zigbeeGroup.moveToLevelCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToLevelWithOnOff', zigbeeGroup.moveToLevelWithOnOffCommandHandler.bind(zigbeeGroup));
            }
            if (useColorTemperature) {
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToColorTemperature', zigbeeGroup.moveToColorTemperatureCommandHandler.bind(zigbeeGroup));
            }
            if (useColor) {
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToHue', zigbeeGroup.moveToHueCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToSaturation', zigbeeGroup.moveToSaturationCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToHueAndSaturation', zigbeeGroup.moveToHueAndSaturationCommandHandler.bind(zigbeeGroup));
                zigbeeGroup.bridgedDevice.addCommandHandler('moveToColor', zigbeeGroup.moveToColorCommandHandler.bind(zigbeeGroup));
            }
        }
        if (isCover) {
            await zigbeeGroup.bridgedDevice.addFixedLabel('type', 'cover');
            zigbeeGroup.bridgedDevice.addCommandHandler('upOrOpen', ({ attributes }) => {
                zigbeeGroup.log.debug(`Command upOrOpen called for ${zigbeeGroup.ien}${group.friendly_name}${rs}${db}`);
                attributes.currentPositionLiftPercent100ths = 0;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeGroup.publishCommand('upOrOpen', group.friendly_name, { state: 'OPEN' });
            });
            zigbeeGroup.bridgedDevice.addCommandHandler('downOrClose', ({ attributes }) => {
                zigbeeGroup.log.debug(`Command downOrClose called for ${zigbeeGroup.ien}${group.friendly_name}${rs}${db}`);
                attributes.currentPositionLiftPercent100ths = 10000;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeGroup.publishCommand('downOrClose', group.friendly_name, { state: 'CLOSE' });
            });
            zigbeeGroup.bridgedDevice.addCommandHandler('stopMotion', ({ attributes }) => {
                zigbeeGroup.log.debug(`Command stopMotion called for ${zigbeeGroup.ien}${group.friendly_name}${rs}${db}`);
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeGroup.publishCommand('stopMotion', group.friendly_name, { state: 'STOP' });
            });
            zigbeeGroup.bridgedDevice.addCommandHandler('goToLiftPercentage', ({ request: { liftPercent100thsValue }, attributes }) => {
                zigbeeGroup.log.debug(`Command goToLiftPercentage called for ${zigbeeGroup.ien}${group.friendly_name}${rs}${db} liftPercent100thsValue: ${liftPercent100thsValue}`);
                attributes.currentPositionLiftPercent100ths = liftPercent100thsValue;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeGroup.publishCommand('goToLiftPercentage', group.friendly_name, { position: 100 - liftPercent100thsValue / 100 });
            });
        }
        if (isThermostat) {
            await zigbeeGroup.bridgedDevice.addFixedLabel('type', 'climate');
            void zigbeeGroup.bridgedDevice.subscribeAttribute(Thermostat.id, 'systemMode', (newValue, oldValue, context) => {
                zigbeeGroup.bridgedDevice?.log.info(`Thermostat systemMode changed from ${oldValue} to ${newValue}`);
                if (oldValue !== newValue && context.fabric !== undefined) {
                    zigbeeGroup.bridgedDevice?.log.info(`Setting thermostat systemMode to ${newValue}`);
                    if (newValue === Thermostat.SystemMode.Off) {
                        zigbeeGroup.publishCommand('SystemMode', group.friendly_name, { system_mode: 'off' });
                    }
                    else if (newValue === Thermostat.SystemMode.Heat) {
                        zigbeeGroup.publishCommand('SystemMode', group.friendly_name, { system_mode: 'heat' });
                    }
                    else if (newValue === Thermostat.SystemMode.Cool) {
                        zigbeeGroup.publishCommand('SystemMode', group.friendly_name, { system_mode: 'cool' });
                    }
                    zigbeeGroup.noUpdate = true;
                    zigbeeGroup.thermostatTimeout = setTimeout(() => {
                        zigbeeGroup.noUpdate = false;
                    }, zigbeeGroup.thermostatTimeoutTime).unref();
                }
            }, zigbeeGroup.log);
            void zigbeeGroup.bridgedDevice.subscribeAttribute(Thermostat.id, 'occupiedHeatingSetpoint', (newValue, oldValue, context) => {
                if (oldValue !== newValue && context.fabric !== undefined) {
                    zigbeeGroup.bridgedDevice?.log.info(`Thermostat occupiedHeatingSetpoint changed from ${oldValue / 100} to ${newValue / 100}`);
                    zigbeeGroup.bridgedDevice?.log.info(`Setting thermostat occupiedHeatingSetpoint to ${newValue / 100}`);
                    zigbeeGroup.publishCommand('CurrentHeatingSetpoint', group.friendly_name, { current_heating_setpoint: Math.round(newValue / 100) });
                    zigbeeGroup.publishCommand('OccupiedHeatingSetpoint', group.friendly_name, { occupied_heating_setpoint: Math.round(newValue / 100) });
                    zigbeeGroup.noUpdate = true;
                    zigbeeGroup.thermostatTimeout = setTimeout(() => {
                        zigbeeGroup.noUpdate = false;
                    }, zigbeeGroup.thermostatTimeoutTime).unref();
                }
            }, zigbeeGroup.log);
            void zigbeeGroup.bridgedDevice.subscribeAttribute(Thermostat.id, 'occupiedCoolingSetpoint', (newValue, oldValue, context) => {
                if (oldValue !== newValue && context.fabric !== undefined) {
                    zigbeeGroup.bridgedDevice?.log.info(`Thermostat occupiedCoolingSetpoint changed from ${oldValue / 100} to ${newValue / 100}`);
                    zigbeeGroup.bridgedDevice?.log.info(`Setting thermostat occupiedCoolingSetpoint to ${newValue / 100}`);
                    zigbeeGroup.publishCommand('CurrentCoolingSetpoint', group.friendly_name, { current_heating_setpoint: Math.round(newValue / 100) });
                    zigbeeGroup.publishCommand('OccupiedCoolingSetpoint', group.friendly_name, { occupied_cooling_setpoint: Math.round(newValue / 100) });
                    zigbeeGroup.noUpdate = true;
                    zigbeeGroup.thermostatTimeout = setTimeout(() => {
                        zigbeeGroup.noUpdate = false;
                    }, zigbeeGroup.thermostatTimeoutTime).unref();
                }
            }, zigbeeGroup.log);
        }
        return zigbeeGroup;
    }
}
const z2ms = [
    { type: 'switch', name: 'state', property: 'state', deviceType: onOffLightSwitch, cluster: OnOff.id, attribute: 'onOff', converter: (value) => { return value === 'ON'; } },
    { type: 'switch', name: 'brightness', property: 'brightness', deviceType: dimmerSwitch, cluster: LevelControl.id, attribute: 'currentLevel', converter: (value) => { return Math.max(1, Math.min(254, value)); } },
    { type: 'switch', name: 'color_hs', property: 'color_hs', deviceType: colorDimmerSwitch, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'switch', name: 'color_xy', property: 'color_xy', deviceType: colorDimmerSwitch, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'switch', name: 'color_temp', property: 'color_temp', deviceType: colorDimmerSwitch, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'outlet', name: 'state', property: 'state', deviceType: onOffPlugInUnit, cluster: OnOff.id, attribute: 'onOff', converter: (value) => { return value === 'ON'; } },
    { type: 'outlet', name: 'brightness', property: 'brightness', deviceType: dimmablePlugInUnit, cluster: LevelControl.id, attribute: 'currentLevel', converter: (value) => { return Math.max(1, Math.min(254, value)); } },
    { type: 'light', name: 'state', property: 'state', deviceType: onOffLight, cluster: OnOff.id, attribute: 'onOff', converter: (value) => { return value === 'ON'; } },
    { type: 'light', name: 'brightness', property: 'brightness', deviceType: dimmableLight, cluster: LevelControl.id, attribute: 'currentLevel', converter: (value) => { return Math.max(1, Math.min(254, value)); } },
    { type: 'light', name: 'color_hs', property: 'color_hs', deviceType: extendedColorLight, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'light', name: 'color_xy', property: 'color_xy', deviceType: extendedColorLight, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'light', name: 'color_temp', property: 'color_temp', deviceType: colorTemperatureLight, cluster: ColorControl.id, attribute: 'colorMode' },
    { type: 'cover', name: 'state', property: 'state', deviceType: windowCovering, cluster: WindowCovering.id, attribute: 'targetPositionLiftPercent100ths' },
    { type: 'cover', name: 'moving', property: 'moving', deviceType: windowCovering, cluster: WindowCovering.id, attribute: 'operationalStatus' },
    { type: 'cover', name: 'position', property: 'position', deviceType: windowCovering, cluster: WindowCovering.id, attribute: 'currentPositionLiftPercent100ths' },
    { type: 'lock', name: 'state', property: 'state', deviceType: doorLock, cluster: DoorLock.id, attribute: 'lockState', converter: (value) => { return value === 'LOCK' ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked; } },
    { type: 'climate', name: 'local_temperature', property: 'local_temperature', deviceType: thermostat, cluster: Thermostat.id, attribute: 'localTemperature', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: 'climate', name: 'current_heating_setpoint', property: 'current_heating_setpoint', deviceType: thermostat, cluster: Thermostat.id, attribute: 'occupiedHeatingSetpoint' },
    { type: 'climate', name: 'occupied_heating_setpoint', property: 'occupied_heating_setpoint', deviceType: thermostat, cluster: Thermostat.id, attribute: 'occupiedHeatingSetpoint', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: 'climate', name: 'occupied_cooling_setpoint', property: 'occupied_cooling_setpoint', deviceType: thermostat, cluster: Thermostat.id, attribute: 'occupiedCoolingSetpoint', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: 'climate', name: 'unoccupied_heating_setpoint', property: 'unoccupied_heating_setpoint', deviceType: thermostat, cluster: Thermostat.id, attribute: 'occupiedHeatingSetpoint', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: 'climate', name: 'unoccupied_cooling_setpoint', property: 'unoccupied_cooling_setpoint', deviceType: thermostat, cluster: Thermostat.id, attribute: 'occupiedCoolingSetpoint', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: 'climate', name: 'running_state', property: 'running_state', deviceType: thermostat, cluster: Thermostat.id, attribute: 'thermostatRunningMode', valueLookup: ['idle', '', '', 'cool', 'heat'] },
    { type: 'climate', name: 'system_mode', property: 'system_mode', deviceType: thermostat, cluster: Thermostat.id, attribute: 'systemMode', valueLookup: ['off', 'auto', '', 'cool', 'heat', '', '', 'fan_only'] },
    { type: '', name: 'min_temperature_limit', property: 'min_temperature_limit', deviceType: thermostat, cluster: Thermostat.id, attribute: 'minHeatSetpointLimit', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: '', name: 'max_temperature_limit', property: 'max_temperature_limit', deviceType: thermostat, cluster: Thermostat.id, attribute: 'maxHeatSetpointLimit', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: '', name: 'min_heat_setpoint_limit', property: 'min_heat_setpoint_limit', deviceType: thermostat, cluster: Thermostat.id, attribute: 'minHeatSetpointLimit', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: '', name: 'max_heat_setpoint_limit', property: 'max_heat_setpoint_limit', deviceType: thermostat, cluster: Thermostat.id, attribute: 'maxHeatSetpointLimit', converter: (value) => { return Math.max(-5000, Math.min(5000, value * 100)); } },
    { type: '', name: 'presence', property: 'presence', deviceType: occupancySensor, cluster: OccupancySensing.id, attribute: 'occupancy', converter: (value) => { return { occupied: value }; } },
    { type: '', name: 'occupancy', property: 'occupancy', deviceType: occupancySensor, cluster: OccupancySensing.id, attribute: 'occupancy', converter: (value) => { return { occupied: value }; } },
    { type: '', name: 'illuminance', property: 'illuminance', deviceType: lightSensor, cluster: IlluminanceMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(Math.max(Math.min(10000 * Math.log10(value), 0xfffe), 0)); } },
    { type: '', name: 'contact', property: 'contact', deviceType: contactSensor, cluster: BooleanState.id, attribute: 'stateValue', converter: (value) => { return value; } },
    { type: '', name: 'water_leak', property: 'water_leak', deviceType: waterLeakDetector, cluster: BooleanState.id, attribute: 'stateValue', converter: (value) => { return value; } },
    { type: '', name: 'rain', property: 'rain', deviceType: rainSensor, cluster: BooleanState.id, attribute: 'stateValue', converter: (value) => { return value; } },
    { type: '', name: 'vibration', property: 'vibration', deviceType: contactSensor, cluster: BooleanState.id, attribute: 'stateValue', converter: (value) => { return !value; } },
    { type: '', name: 'smoke', property: 'smoke', deviceType: smokeCoAlarm, cluster: SmokeCoAlarm.id, attribute: 'smokeState', converter: (value) => { return value ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal; } },
    { type: '', name: 'carbon_monoxide', property: 'carbon_monoxide', deviceType: contactSensor, cluster: BooleanState.id, attribute: 'stateValue', converter: (value) => { return !value; } },
    { type: '', name: 'temperature', property: 'temperature', deviceType: temperatureSensor, cluster: TemperatureMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value * 100); } },
    { type: '', name: 'humidity', property: 'humidity', deviceType: humiditySensor, cluster: RelativeHumidityMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value * 100); } },
    { type: '', name: 'soil_moisture', property: 'soil_moisture', deviceType: humiditySensor, cluster: RelativeHumidityMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value * 100); } },
    { type: '', name: 'pressure', property: 'pressure', deviceType: pressureSensor, cluster: PressureMeasurement.id, attribute: 'measuredValue', converter: (value) => { return value; } },
    { type: '', name: 'air_quality', property: 'air_quality', deviceType: airQualitySensor, cluster: AirQuality.id, attribute: 'airQuality', valueLookup: ['unknown', 'excellent', 'good', 'moderate', 'poor', 'unhealthy', 'out_of_range'] },
    { type: '', name: 'voc', property: 'voc', deviceType: airQualitySensor, cluster: TotalVolatileOrganicCompoundsConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.min(65535, value); } },
    { type: '', name: 'co', property: 'co', deviceType: airQualitySensor, cluster: CarbonMonoxideConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'co2', property: 'co2', deviceType: airQualitySensor, cluster: CarbonDioxideConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'formaldehyd', property: 'formaldehyd', deviceType: airQualitySensor, cluster: FormaldehydeConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'pm1', property: 'pm1', deviceType: airQualitySensor, cluster: Pm1ConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'pm25', property: 'pm25', deviceType: airQualitySensor, cluster: Pm25ConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'pm10', property: 'pm10', deviceType: airQualitySensor, cluster: Pm10ConcentrationMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value); } },
    { type: '', name: 'cpu_temperature', property: 'temperature', deviceType: temperatureSensor, cluster: TemperatureMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value * 100); } },
    { type: '', name: 'device_temperature', property: 'device_temperature', deviceType: temperatureSensor, cluster: TemperatureMeasurement.id, attribute: 'measuredValue', converter: (value) => { return Math.round(value * 100); } },
    { type: '', name: '', property: 'battery', deviceType: powerSource, cluster: PowerSource.id, attribute: 'batPercentRemaining', converter: (value) => { return Math.round(value * 2); } },
    { type: '', name: '', property: 'battery_low', deviceType: powerSource, cluster: PowerSource.id, attribute: 'batChargeLevel', converter: (value) => { return value === true ? PowerSource.BatChargeLevel.Critical : PowerSource.BatChargeLevel.Ok; } },
    { type: '', name: '', property: 'battery_voltage', deviceType: powerSource, cluster: PowerSource.id, attribute: 'batVoltage', converter: (value) => { return value; } },
    { type: '', name: 'energy', property: 'energy', deviceType: electricalSensor, cluster: ElectricalEnergyMeasurement.id, attribute: 'cumulativeEnergyImported', converter: (value) => { return { energy: Math.round(value * 1000000) }; } },
    { type: '', name: 'power', property: 'power', deviceType: electricalSensor, cluster: ElectricalPowerMeasurement.id, attribute: 'activePower', converter: (value) => { return Math.round(value * 1000); } },
    { type: '', name: 'voltage', property: 'voltage', deviceType: electricalSensor, cluster: ElectricalPowerMeasurement.id, attribute: 'voltage', converter: (value) => { return Math.round(value * 1000); } },
    { type: '', name: 'current', property: 'current', deviceType: electricalSensor, cluster: ElectricalPowerMeasurement.id, attribute: 'activeCurrent', converter: (value) => { return Math.round(value * 1000); } },
];
export class ZigbeeDevice extends ZigbeeEntity {
    constructor(platform, device) {
        super(platform, device);
    }
    static async create(platform, device) {
        const zigbeeDevice = new ZigbeeDevice(platform, device);
        zigbeeDevice.serial = device.ieee_address;
        if (zigbeeDevice.platform.postfix !== '') {
            zigbeeDevice.serial = `${zigbeeDevice.serial}-${zigbeeDevice.platform.postfix}`.slice(0, 32);
        }
        if (device.friendly_name === 'Coordinator' ||
            (device.model_id === 'ti.router' && device.manufacturer === 'TexasInstruments') ||
            (device.model_id.startsWith('SLZB-') && device.manufacturer === 'SMLIGHT')) {
            zigbeeDevice.isRouter = true;
            platform.setSelectDevice(device.ieee_address, device.friendly_name, 'wifi');
            zigbeeDevice.bridgedDevice = new MatterbridgeEndpoint([doorLock, bridgedNode, powerSource], { id: device.friendly_name }, zigbeeDevice.log.logLevel === "debug");
            zigbeeDevice.addBridgedDeviceBasicInformation();
            zigbeeDevice.addPowerSource();
            zigbeeDevice.bridgedDevice.addRequiredClusters();
            await zigbeeDevice.bridgedDevice.addFixedLabel('type', 'lock');
            zigbeeDevice.verifyMutableDevice(zigbeeDevice.bridgedDevice);
            zigbeeDevice.bridgedDevice.addCommandHandler('identify', (data) => {
                zigbeeDevice.log.debug(`Command identify called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} request identifyTime:${data.request.identifyTime} `);
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('lockDoor', () => {
                zigbeeDevice.log.debug(`Command permit_join false called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                zigbeeDevice.publishCommand('permit_join false', 'bridge/request/permit_join', { value: false });
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('unlockDoor', () => {
                zigbeeDevice.log.debug(`Command permit_join true called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                zigbeeDevice.publishCommand('permit_join true', 'bridge/request/permit_join', { value: true });
            });
            return zigbeeDevice;
        }
        if (!platform.featureBlackList?.includes('scenes') && !platform.deviceFeatureBlackList[device.friendly_name]?.includes('scenes')) {
            for (const [key, endpoint] of Object.entries(device.endpoints)) {
                for (const scene of Object.values(endpoint.scenes)) {
                    zigbeeDevice.log.debug(`***Device ${dn}${device.friendly_name}${rs}${db} endpoint ${CYAN}${key}${db} scene ${CYAN}${scene.name}${db} id ${CYAN}${scene.id}${db}`);
                    platform.setSelectDeviceEntity(device.ieee_address, 'scenes', 'Scenes', 'component');
                    await platform.registerVirtualDevice(`${platform.config.scenesPrefix ? device.friendly_name + ' ' : ''}${scene.name}`, platform.config.scenesType, async () => {
                        zigbeeDevice.log.info(`Triggered scene "${scene.name}" id ${scene.id} from device ${device.friendly_name}`);
                        zigbeeDevice.publishCommand('scene_recall', device.friendly_name, { scene_recall: scene.id });
                    });
                }
            }
        }
        const types = [];
        const endpoints = [];
        const names = [];
        const properties = [];
        const categories = [];
        const descriptions = [];
        const labels = [];
        const units = [];
        const value_mins = [];
        const value_maxs = [];
        const values = [];
        device.definition?.exposes.forEach((expose) => {
            if (expose.features) {
                expose.features?.forEach((feature) => {
                    if (expose.type === 'lock' && feature.name === 'state' && feature.property === 'child_lock')
                        feature.name = 'child_lock';
                    types.push(expose.type);
                    endpoints.push(expose.endpoint || '');
                    names.push(feature.name);
                    properties.push(feature.property);
                    categories.push(feature.category ?? '');
                    descriptions.push(feature.description ?? '');
                    labels.push(feature.label ?? '');
                    units.push(feature.unit ?? '');
                    value_mins.push(feature.value_min ?? Number.NaN);
                    value_maxs.push(feature.value_max ?? Number.NaN);
                    values.push(feature.values ? feature.values.join('|') : '');
                });
            }
            else {
                if (device.power_source === 'Battery' && expose.name === 'voltage')
                    expose.name = 'battery_voltage';
                if (device.power_source === 'Battery' && expose.property === 'voltage')
                    expose.property = 'battery_voltage';
                types.push('');
                endpoints.push(expose.endpoint || '');
                names.push(expose.name || '');
                properties.push(expose.property);
                categories.push(expose.category ?? '');
                descriptions.push(expose.description ?? '');
                labels.push(expose.label ?? '');
                units.push(expose.unit ?? '');
                value_mins.push(expose.value_min ?? Number.NaN);
                value_maxs.push(expose.value_max ?? Number.NaN);
                values.push(expose.values ? expose.values.join('|') : '');
                if (expose.name === 'action' && expose.values) {
                    zigbeeDevice.actions.push(...expose.values);
                }
            }
        });
        device.definition?.options.forEach((option) => {
            types.push('');
            endpoints.push(option.endpoint || '');
            names.push(option.name || '');
            properties.push(option.property);
            categories.push(option.category ?? '');
            descriptions.push(option.description ?? '');
            labels.push(option.label ?? '');
            units.push(option.unit ?? '');
            value_mins.push(option.value_min ?? Number.NaN);
            value_maxs.push(option.value_max ?? Number.NaN);
            values.push(option.values ? option.values.join('|') : '');
        });
        if (platform.switchList.includes(device.friendly_name)) {
            types.forEach((type, index) => {
                types[index] = type === 'light' ? 'switch' : type;
            });
        }
        if (platform.lightList.includes(device.friendly_name)) {
            types.forEach((type, index) => {
                types[index] = type === 'switch' ? 'light' : type;
            });
        }
        if (platform.outletList.includes(device.friendly_name)) {
            types.forEach((type, index) => {
                types[index] = type === 'switch' || type === 'light' ? 'outlet' : type;
            });
        }
        platform.setSelectEntity('last_seen', 'Last seen', 'hub');
        for (const [index, property] of properties.entries()) {
            platform.setSelectDevice(device.ieee_address, device.friendly_name, 'wifi');
            if (endpoints[index] === '')
                platform.setSelectEntity(property, descriptions[index], 'hub');
            platform.setSelectDeviceEntity(device.ieee_address, property, descriptions[index], 'hub');
        }
        if (platform.featureBlackList)
            zigbeeDevice.ignoreFeatures = [...zigbeeDevice.ignoreFeatures, ...platform.featureBlackList];
        if (platform.deviceFeatureBlackList[device.friendly_name])
            zigbeeDevice.ignoreFeatures = [...zigbeeDevice.ignoreFeatures, ...platform.deviceFeatureBlackList[device.friendly_name]];
        for (const [index, name] of names.entries()) {
            if (platform.featureBlackList.includes(name) || platform.featureBlackList.includes(properties[index])) {
                zigbeeDevice.log.debug(`Device ${zigbeeDevice.en}${device.friendly_name}${db} feature ${name} property ${properties[index]} is globally blacklisted`);
                continue;
            }
            if (platform.deviceFeatureBlackList[device.friendly_name]?.includes(name) || platform.deviceFeatureBlackList[device.friendly_name]?.includes(properties[index])) {
                zigbeeDevice.log.debug(`Device ${zigbeeDevice.en}${device.friendly_name}${db} feature ${name} property ${properties[index]} is blacklisted`);
                continue;
            }
            if (name === 'transition') {
                zigbeeDevice.log.debug(`*Device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} transition is supported`);
                zigbeeDevice.transition = true;
            }
            const type = types[index];
            const endpoint = endpoints[index];
            const property = properties[index];
            const unit = units[index];
            const category = categories[index];
            const description = descriptions[index];
            const label = labels[index];
            const value_min = value_mins[index];
            const value_max = value_maxs[index];
            const value = values[index];
            const z2m = z2ms.find((z2m) => z2m.type === type && z2m.name === name);
            if (z2m) {
                zigbeeDevice.log.debug(`Device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} endpoint: ${zb}${endpoint}${db} type: ${zb}${type}${db} property: ${zb}${name}${db} => deviceType: ${z2m.deviceType?.name} cluster: ${z2m.cluster} attribute: ${z2m.attribute}`);
                zigbeeDevice.propertyMap.set(property, { name, type, endpoint, category, description, label, unit, value_min, value_max, values: value });
                if (endpoint === '') {
                    if (zigbeeDevice.mutableDevice.has(endpoint)) {
                        zigbeeDevice.mutableDevice.get(endpoint)?.deviceTypes.push(z2m.deviceType);
                        zigbeeDevice.mutableDevice.get(endpoint)?.clusterServersIds.push(...z2m.deviceType.requiredServerClusters);
                        zigbeeDevice.mutableDevice.get(endpoint)?.clusterServersIds.push(ClusterId(z2m.cluster));
                    }
                    else {
                        zigbeeDevice.mutableDevice.set(endpoint, { tagList: [], deviceTypes: [z2m.deviceType], clusterServersIds: [...z2m.deviceType.requiredServerClusters, ClusterId(z2m.cluster)], clusterServersOptions: [], clusterClientsIds: [], clusterClientsOptions: [] });
                    }
                }
                else {
                    const tagList = [];
                    if (endpoint === 'l1')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.One.namespaceId, tag: CommonNumberTag.One.tag, label: 'endpoint ' + endpoint });
                    if (endpoint === 'l2')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.Two.namespaceId, tag: CommonNumberTag.Two.tag, label: 'endpoint ' + endpoint });
                    if (endpoint === 'l3')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.Three.namespaceId, tag: CommonNumberTag.Three.tag, label: 'endpoint ' + endpoint });
                    if (endpoint === 'l4')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.Four.namespaceId, tag: CommonNumberTag.Four.tag, label: 'endpoint ' + endpoint });
                    if (endpoint === 'l5')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.Five.namespaceId, tag: CommonNumberTag.Five.tag, label: 'endpoint ' + endpoint });
                    if (endpoint === 'l6')
                        tagList.push({ mfgCode: null, namespaceId: CommonNumberTag.Six.namespaceId, tag: CommonNumberTag.Six.tag, label: 'endpoint ' + endpoint });
                    tagList.push({ mfgCode: null, namespaceId: SwitchesTag.Custom.namespaceId, tag: SwitchesTag.Custom.tag, label: 'endpoint ' + endpoint });
                    if (zigbeeDevice.mutableDevice.has(endpoint)) {
                        zigbeeDevice.mutableDevice.get(endpoint)?.deviceTypes.push(z2m.deviceType);
                        zigbeeDevice.mutableDevice.get(endpoint)?.clusterServersIds.push(...z2m.deviceType.requiredServerClusters, ClusterId(z2m.cluster));
                    }
                    else {
                        zigbeeDevice.mutableDevice.set(endpoint, { tagList, deviceTypes: [z2m.deviceType], clusterServersIds: [...z2m.deviceType.requiredServerClusters, ClusterId(z2m.cluster)], clusterServersOptions: [], clusterClientsIds: [], clusterClientsOptions: [] });
                    }
                    if (zigbeeDevice.composedType === '')
                        zigbeeDevice.composedType = type;
                    zigbeeDevice.hasEndpoints = true;
                }
            }
            else {
            }
            if (name === 'action' && zigbeeDevice.actions.length) {
                zigbeeDevice.log.info(`Device ${zigbeeDevice.ien}${device.friendly_name}${rs}${nf} has actions mapped to these switches on sub endpoints:`);
                zigbeeDevice.log.info('   controller events      <=> zigbee2mqtt actions');
                zigbeeDevice.bridgedDevice ??= new MatterbridgeEndpoint([bridgedNode], { id: device.friendly_name }, zigbeeDevice.log.logLevel === "debug");
                zigbeeDevice.hasEndpoints = true;
                const switchMap = ['Single Press', 'Double Press', 'Long Press  '];
                const triggerMap = ['Single', 'Double', 'Long'];
                let count = 1;
                if (zigbeeDevice.actions.length <= 3) {
                    const actionsMap = [];
                    for (let a = 0; a < zigbeeDevice.actions.length; a++) {
                        actionsMap.push(zigbeeDevice.actions[a]);
                        zigbeeDevice.propertyMap.set('action_' + actionsMap[a], { name, type: '', endpoint: 'switch_' + count, action: triggerMap[a] });
                        zigbeeDevice.log.info(`-- Button ${count}: ${hk}${switchMap[a]}${nf} <=> ${zb}${actionsMap[a]}${nf}`);
                    }
                    const tagList = [];
                    tagList.push({ mfgCode: null, namespaceId: SwitchesTag.Custom.namespaceId, tag: SwitchesTag.Custom.tag, label: 'switch_' + count });
                    zigbeeDevice.mutableDevice.set('switch_' + count, {
                        tagList,
                        deviceTypes: [genericSwitch],
                        clusterServersIds: [...genericSwitch.requiredServerClusters],
                        clusterServersOptions: [],
                        clusterClientsIds: [],
                        clusterClientsOptions: [],
                    });
                }
                else {
                    for (let i = 0; i < zigbeeDevice.actions.length; i += 3) {
                        const actionsMap = [];
                        for (let a = i; a < i + 3 && a < zigbeeDevice.actions.length; a++) {
                            actionsMap.push(zigbeeDevice.actions[a]);
                            zigbeeDevice.propertyMap.set('action_' + actionsMap[a - i], { name, type: '', endpoint: 'switch_' + count, action: triggerMap[a - i] });
                            zigbeeDevice.log.info(`-- Button ${count}: ${hk}${switchMap[a - i]}${nf} <=> ${zb}${actionsMap[a - i]}${nf}`);
                        }
                        const tagList = [];
                        tagList.push({ mfgCode: null, namespaceId: SwitchesTag.Custom.namespaceId, tag: SwitchesTag.Custom.tag, label: 'switch_' + count });
                        zigbeeDevice.mutableDevice.set('switch_' + count, {
                            tagList,
                            deviceTypes: [genericSwitch],
                            clusterServersIds: [...genericSwitch.requiredServerClusters],
                            clusterServersOptions: [],
                            clusterClientsIds: [],
                            clusterClientsOptions: [],
                        });
                        count++;
                    }
                }
                if (zigbeeDevice.composedType === '')
                    zigbeeDevice.composedType = 'button';
            }
        }
        if (device.power_source === 'Battery') {
            zigbeeDevice.propertyMap.set('battery', { name: 'battery', type: '', endpoint: '' });
            zigbeeDevice.propertyMap.set('battery_low', { name: 'battery_low', type: '', endpoint: '' });
            zigbeeDevice.propertyMap.set('battery_voltage', { name: 'battery_voltage', type: '', endpoint: '' });
        }
        if (!zigbeeDevice.mutableDevice.has(''))
            zigbeeDevice.mutableDevice.set('', {
                tagList: [],
                deviceTypes: [bridgedNode, powerSource],
                clusterServersIds: [],
                clusterServersOptions: [],
                clusterClientsIds: [],
                clusterClientsOptions: [],
            });
        const mainEndpoint = zigbeeDevice.mutableDevice.get('');
        if (!mainEndpoint)
            return zigbeeDevice;
        for (const device of zigbeeDevice.mutableDevice.values()) {
            const deviceTypesMap = new Map();
            device.deviceTypes.forEach((deviceType) => {
                deviceTypesMap.set(deviceType.code, deviceType);
            });
            if (deviceTypesMap.has(onOffLightSwitch.code) && deviceTypesMap.has(dimmerSwitch.code))
                deviceTypesMap.delete(onOffLightSwitch.code);
            if (deviceTypesMap.has(dimmerSwitch.code) && deviceTypesMap.has(colorDimmerSwitch.code))
                deviceTypesMap.delete(dimmerSwitch.code);
            if (deviceTypesMap.has(onOffPlugInUnit.code) && deviceTypesMap.has(dimmablePlugInUnit.code))
                deviceTypesMap.delete(onOffPlugInUnit.code);
            if (deviceTypesMap.has(onOffLight.code) && deviceTypesMap.has(dimmableLight.code))
                deviceTypesMap.delete(onOffLight.code);
            if (deviceTypesMap.has(dimmableLight.code) && deviceTypesMap.has(colorTemperatureLight.code))
                deviceTypesMap.delete(dimmableLight.code);
            if (deviceTypesMap.has(dimmableLight.code) && deviceTypesMap.has(extendedColorLight.code))
                deviceTypesMap.delete(dimmableLight.code);
            if (deviceTypesMap.has(colorTemperatureLight.code) && deviceTypesMap.has(extendedColorLight.code))
                deviceTypesMap.delete(colorTemperatureLight.code);
            deviceTypesMap.delete(bridgedNode.code);
            deviceTypesMap.delete(powerSource.code);
            device.deviceTypes = Array.from(deviceTypesMap.values());
        }
        zigbeeDevice.bridgedDevice = new MatterbridgeEndpoint([...mainEndpoint.deviceTypes, bridgedNode, powerSource], { id: device.friendly_name }, zigbeeDevice.log.logLevel === "debug");
        zigbeeDevice.addBridgedDeviceBasicInformation();
        zigbeeDevice.addPowerSource();
        if (mainEndpoint.clusterServersIds.includes(PowerSource.id)) {
            mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(PowerSource.id), 1);
        }
        for (const [endpoint, device] of zigbeeDevice.mutableDevice) {
            const deviceClusterServersIdMap = new Map();
            device.clusterServersIds.forEach((clusterServer) => {
                deviceClusterServersIdMap.set(clusterServer, clusterServer);
            });
            const deviceClusterServersObjMap = new Map();
            device.clusterServersOptions.forEach((clusterServer) => {
                deviceClusterServersIdMap.delete(clusterServer.clusterId);
                deviceClusterServersObjMap.set(clusterServer.clusterId, clusterServer);
            });
            device.clusterServersIds = Array.from(deviceClusterServersIdMap.values());
            device.clusterServersOptions = Array.from(deviceClusterServersObjMap.values());
            const deviceClusterClientsIdMap = new Map();
            device.clusterClientsIds.forEach((clusterClient) => {
                deviceClusterClientsIdMap.set(clusterClient, clusterClient);
            });
            const deviceClusterClientsObjMap = new Map();
            device.clusterClientsOptions.forEach((clusterClient) => {
                deviceClusterClientsIdMap.delete(clusterClient.clusterId);
                deviceClusterClientsObjMap.set(clusterClient.clusterId, clusterClient);
            });
            device.clusterClientsIds = Array.from(deviceClusterClientsIdMap.values());
            device.clusterClientsOptions = Array.from(deviceClusterClientsObjMap.values());
            zigbeeDevice.log.debug(`Device ${zigbeeDevice.ien}${zigbeeDevice.device?.friendly_name}${rs}${db} endpoint: ${ign}${endpoint === '' ? 'main' : endpoint}${rs}${db} => ` +
                `${nf}tagList: ${debugStringify(device.tagList)} deviceTypes: ${debugStringify(device.deviceTypes)} clusterServersIds: ${debugStringify(device.clusterServersIds)}`);
        }
        if ((mainEndpoint.deviceTypes.find((dt) => dt.code === waterLeakDetector.code) || mainEndpoint.deviceTypes.find((dt) => dt.code === rainSensor.code)) &&
            mainEndpoint.clusterServersIds.includes(BooleanState.id)) {
            zigbeeDevice.log.debug(`Configuring device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} BooleanStateCluster cluster with`);
            zigbeeDevice.bridgedDevice.createDefaultBooleanStateClusterServer(false);
            mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(BooleanState.id), 1);
        }
        if (mainEndpoint.deviceTypes.find((dt) => dt.code === smokeCoAlarm.code) && mainEndpoint.clusterServersIds.includes(SmokeCoAlarm.id)) {
            zigbeeDevice.log.debug(`Configuring device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} SmokeCoAlarmCluster cluster with`);
            zigbeeDevice.bridgedDevice.createSmokeOnlySmokeCOAlarmClusterServer(SmokeCoAlarm.AlarmState.Normal);
            mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(SmokeCoAlarm.id), 1);
        }
        if (mainEndpoint.clusterServersIds.includes(ColorControl.id)) {
            if (!names.includes('color_hs') && !names.includes('color_xy')) {
                zigbeeDevice.log.debug(`Configuring device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} ColorControlCluster cluster with CT: ${names.includes('color_temp')} min: ${zigbeeDevice.propertyMap.get('color_temp')?.value_min} max: ${zigbeeDevice.propertyMap.get('color_temp')?.value_max}`);
                zigbeeDevice.bridgedDevice.createCtColorControlClusterServer();
            }
            else {
                zigbeeDevice.log.debug(`Configuring device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} ColorControlCluster cluster with HS: ${names.includes('color_hs')} XY: ${names.includes('color_xy')} CT: ${names.includes('color_temp')} min: ${zigbeeDevice.propertyMap.get('color_temp')?.value_min} max: ${zigbeeDevice.propertyMap.get('color_temp')?.value_max}`);
                zigbeeDevice.bridgedDevice.createDefaultColorControlClusterServer();
            }
            mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(ColorControl.id), 1);
        }
        if (mainEndpoint.clusterServersIds.includes(Thermostat.id)) {
            const system_mode = zigbeeDevice.propertyMap.get('system_mode');
            const system_mode_values = system_mode?.values;
            const heat = zigbeeDevice.propertyMap.get('occupied_heating_setpoint') ?? zigbeeDevice.propertyMap.get('unoccupied_heating_setpoint');
            const cool = zigbeeDevice.propertyMap.get('occupied_cooling_setpoint') ?? zigbeeDevice.propertyMap.get('unoccupied_cooling_setpoint');
            const minHeating = heat?.value_min !== undefined && !Number.isNaN(heat.value_min) ? heat.value_min : 0;
            const maxHeating = heat?.value_max !== undefined && !Number.isNaN(heat.value_max) ? heat.value_max : 50;
            const minCooling = cool?.value_min !== undefined && !Number.isNaN(cool.value_min) ? cool.value_min : 0;
            const maxCooling = cool?.value_max !== undefined && !Number.isNaN(cool.value_max) ? cool.value_max : 50;
            zigbeeDevice.log.debug(`Configuring device ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} Thermostat cluster with heating ${CYAN}${heat ? 'supported' : '(un)occupied not supported'}${db} cooling ${CYAN}${cool ? 'supported' : '(un)occupied not supported'}${db} ` +
                `system_mode ${CYAN}${system_mode_values ?? 'not supported'}${db} ` +
                `minHeating ${CYAN}${minHeating}${db} maxHeating ${CYAN}${maxHeating}${db} minCooling ${CYAN}${minCooling}${db} maxCooling ${CYAN}${maxCooling}${db}`);
            if ((heat && !cool) || (!system_mode_values?.includes('auto') && system_mode_values?.includes('heat'))) {
                zigbeeDevice.propertyMap.delete('running_state');
                zigbeeDevice.bridgedDevice.createDefaultHeatingThermostatClusterServer(undefined, undefined, minHeating, maxHeating);
                mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(Thermostat.id), 1);
                const sMode = zigbeeDevice.propertyMap.get('system_mode');
                if (sMode)
                    sMode.values = 'off|heat';
            }
            else if ((!heat && cool) || (!system_mode_values?.includes('auto') && system_mode_values?.includes('cool'))) {
                zigbeeDevice.propertyMap.delete('running_state');
                zigbeeDevice.bridgedDevice.createDefaultCoolingThermostatClusterServer(undefined, undefined, minCooling, maxCooling);
                mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(Thermostat.id), 1);
                const sMode = zigbeeDevice.propertyMap.get('system_mode');
                if (sMode)
                    sMode.values = 'off|cool';
            }
            else {
                zigbeeDevice.bridgedDevice.createDefaultThermostatClusterServer(undefined, undefined, undefined, undefined, minHeating, maxHeating, minCooling, maxCooling);
                mainEndpoint.clusterServersIds.splice(mainEndpoint.clusterServersIds.indexOf(Thermostat.id), 1);
            }
        }
        zigbeeDevice.bridgedDevice.addClusterServers(mainEndpoint.clusterServersIds);
        zigbeeDevice.bridgedDevice.addRequiredClusters();
        if (zigbeeDevice.composedType !== '')
            await zigbeeDevice.bridgedDevice.addFixedLabel('composed', zigbeeDevice.composedType);
        for (const [endpoint, device] of zigbeeDevice.mutableDevice) {
            if (endpoint === '')
                continue;
            zigbeeDevice.bridgedDevice?.addChildDeviceTypeWithClusterServer(endpoint, device.deviceTypes, device.clusterServersIds, { tagList: device.tagList }, zigbeeDevice.log.logLevel === "debug");
        }
        if (!zigbeeDevice.verifyMutableDevice(zigbeeDevice.bridgedDevice))
            return zigbeeDevice;
        zigbeeDevice.mutableDevice.clear();
        zigbeeDevice.logPropertyMap();
        if (zigbeeDevice.bridgedDevice.hasClusterServer(Identify.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('identify', ({ request: { identifyTime } }) => {
                zigbeeDevice.log.debug(`Command identify called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} identifyTime:${identifyTime}`);
            });
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(OnOff.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('on', zigbeeDevice.onCommandHandler.bind(zigbeeDevice));
            zigbeeDevice.bridgedDevice.addCommandHandler('off', zigbeeDevice.offCommandHandler.bind(zigbeeDevice));
            zigbeeDevice.bridgedDevice.addCommandHandler('toggle', zigbeeDevice.toggleCommandHandler.bind(zigbeeDevice));
        }
        for (const child of zigbeeDevice.bridgedDevice.getChildEndpoints()) {
            if (child.hasClusterServer(OnOff.id)) {
                child.addCommandHandler('on', zigbeeDevice.onCommandHandler.bind(zigbeeDevice));
                child.addCommandHandler('off', zigbeeDevice.offCommandHandler.bind(zigbeeDevice));
                child.addCommandHandler('toggle', zigbeeDevice.toggleCommandHandler.bind(zigbeeDevice));
            }
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(LevelControl.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToLevel', zigbeeDevice.moveToLevelCommandHandler.bind(zigbeeDevice));
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToLevelWithOnOff', zigbeeDevice.moveToLevelWithOnOffCommandHandler.bind(zigbeeDevice));
        }
        for (const child of zigbeeDevice.bridgedDevice.getChildEndpoints()) {
            if (child.hasClusterServer(LevelControl.id)) {
                child.addCommandHandler('moveToLevel', zigbeeDevice.moveToLevelCommandHandler.bind(zigbeeDevice));
                child.addCommandHandler('moveToLevelWithOnOff', zigbeeDevice.moveToLevelWithOnOffCommandHandler.bind(zigbeeDevice));
            }
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(ColorControl.id) && zigbeeDevice.bridgedDevice.hasAttributeServer(ColorControl.id, 'colorTemperatureMireds')) {
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToColorTemperature', zigbeeDevice.moveToColorTemperatureCommandHandler.bind(zigbeeDevice));
        }
        for (const child of zigbeeDevice.bridgedDevice.getChildEndpoints()) {
            if (child.hasClusterServer(ColorControl.id) && child.hasAttributeServer(ColorControl.id, 'colorTemperatureMireds')) {
                child.addCommandHandler('moveToColorTemperature', zigbeeDevice.moveToColorTemperatureCommandHandler.bind(zigbeeDevice));
            }
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(ColorControl.id) && zigbeeDevice.bridgedDevice.hasAttributeServer(ColorControl.id, 'currentX')) {
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToColor', zigbeeDevice.moveToColorCommandHandler.bind(zigbeeDevice));
        }
        for (const child of zigbeeDevice.bridgedDevice.getChildEndpoints()) {
            if (child.hasClusterServer(ColorControl.id) && child.hasAttributeServer(ColorControl.id, 'currentX')) {
                child.addCommandHandler('moveToColor', zigbeeDevice.moveToColorCommandHandler.bind(zigbeeDevice));
            }
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(ColorControl.id) && zigbeeDevice.bridgedDevice.hasAttributeServer(ColorControl.id, 'currentHue')) {
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToHue', zigbeeDevice.moveToHueCommandHandler.bind(zigbeeDevice));
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToSaturation', zigbeeDevice.moveToSaturationCommandHandler.bind(zigbeeDevice));
            zigbeeDevice.bridgedDevice.addCommandHandler('moveToHueAndSaturation', zigbeeDevice.moveToHueAndSaturationCommandHandler.bind(zigbeeDevice));
        }
        for (const child of zigbeeDevice.bridgedDevice.getChildEndpoints()) {
            if (child.hasClusterServer(ColorControl.id) && child.hasAttributeServer(ColorControl.id, 'currentHue')) {
                child.addCommandHandler('moveToHue', zigbeeDevice.moveToHueCommandHandler.bind(zigbeeDevice));
                child.addCommandHandler('moveToSaturation', zigbeeDevice.moveToSaturationCommandHandler.bind(zigbeeDevice));
                child.addCommandHandler('moveToHueAndSaturation', zigbeeDevice.moveToHueAndSaturationCommandHandler.bind(zigbeeDevice));
            }
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(WindowCovering.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('upOrOpen', ({ attributes }) => {
                zigbeeDevice.log.debug(`Command upOrOpen called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                attributes.currentPositionLiftPercent100ths = 0;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeDevice.publishCommand('upOrOpen', device.friendly_name, { state: 'OPEN' });
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('downOrClose', ({ attributes }) => {
                zigbeeDevice.log.debug(`Command downOrClose called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                attributes.currentPositionLiftPercent100ths = 10000;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeDevice.publishCommand('downOrClose', device.friendly_name, { state: 'CLOSE' });
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('stopMotion', ({ attributes }) => {
                zigbeeDevice.log.debug(`Command stopMotion called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeDevice.publishCommand('stopMotion', device.friendly_name, { state: 'STOP' });
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('goToLiftPercentage', ({ request: { liftPercent100thsValue }, attributes }) => {
                zigbeeDevice.log.debug(`Command goToLiftPercentage called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} request liftPercent100thsValue: ${liftPercent100thsValue}`);
                attributes.currentPositionLiftPercent100ths = liftPercent100thsValue;
                attributes.operationalStatus = {
                    global: WindowCovering.MovementStatus.Stopped,
                    lift: WindowCovering.MovementStatus.Stopped,
                    tilt: WindowCovering.MovementStatus.Stopped,
                };
                zigbeeDevice.publishCommand('goToLiftPercentage', device.friendly_name, { position: (10000 - liftPercent100thsValue) / 100 });
            });
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(DoorLock.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('lockDoor', () => {
                zigbeeDevice.log.debug(`Command lockDoor called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                zigbeeDevice.publishCommand('lockDoor', device.friendly_name, { state: 'LOCK' });
            });
            zigbeeDevice.bridgedDevice.addCommandHandler('unlockDoor', () => {
                zigbeeDevice.log.debug(`Command unlockDoor called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db}`);
                zigbeeDevice.publishCommand('unlockDoor', device.friendly_name, { state: 'UNLOCK' });
            });
        }
        if (zigbeeDevice.bridgedDevice.hasClusterServer(Thermostat.id)) {
            zigbeeDevice.bridgedDevice.addCommandHandler('setpointRaiseLower', ({ request }) => {
                zigbeeDevice.log.debug(`Command setpointRaiseLower called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} request:`, request);
                if (request.mode === Thermostat.SetpointRaiseLowerMode.Heat || request.mode === Thermostat.SetpointRaiseLowerMode.Both) {
                    const t = zigbeeDevice.bridgedDevice?.getAttribute(Thermostat.id, 'occupiedHeatingSetpoint', zigbeeDevice.log);
                    const setpoint = Math.round(t / 100 + request.amount / 10);
                    if (zigbeeDevice.propertyMap.has('current_heating_setpoint')) {
                        zigbeeDevice.publishCommand('CurrentHeatingSetpoint', device.friendly_name, { current_heating_setpoint: setpoint });
                    }
                    else if (zigbeeDevice.propertyMap.has('occupied_heating_setpoint')) {
                        zigbeeDevice.publishCommand('OccupiedHeatingSetpoint', device.friendly_name, { occupied_heating_setpoint: setpoint });
                    }
                }
                if (request.mode === Thermostat.SetpointRaiseLowerMode.Cool || request.mode === Thermostat.SetpointRaiseLowerMode.Both) {
                    const t = zigbeeDevice.bridgedDevice?.getAttribute(Thermostat.id, 'occupiedCoolingSetpoint', zigbeeDevice.log);
                    const setpoint = Math.round(t / 100 + request.amount / 10);
                    if (zigbeeDevice.propertyMap.has('current_heating_setpoint')) {
                        zigbeeDevice.publishCommand('CurrentCoolingSetpoint', device.friendly_name, { current_heating_setpoint: setpoint });
                    }
                    else if (zigbeeDevice.propertyMap.has('occupied_cooling_setpoint')) {
                        zigbeeDevice.publishCommand('OccupiedCoolingSetpoint', device.friendly_name, { occupied_cooling_setpoint: setpoint });
                    }
                }
            });
            void zigbeeDevice.bridgedDevice.subscribeAttribute(Thermostat.id, 'systemMode', (newValue, oldValue, context) => {
                if (newValue === oldValue || context.fabric === undefined)
                    return;
                if (isValidNumber(newValue, Thermostat.SystemMode.Off, Thermostat.SystemMode.FanOnly) && zigbeeDevice.thermostatSystemModeLookup[newValue] !== '') {
                    const system_mode = zigbeeDevice.thermostatSystemModeLookup[newValue];
                    zigbeeDevice.log.debug(`Subscribe systemMode called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} with ${newValue} => ${system_mode}`);
                    zigbeeDevice.publishCommand('SystemMode', device.friendly_name, { system_mode });
                    zigbeeDevice.noUpdate = true;
                    zigbeeDevice.thermostatTimeout = setTimeout(() => {
                        zigbeeDevice.noUpdate = false;
                    }, zigbeeDevice.thermostatTimeoutTime).unref();
                }
            }, zigbeeDevice.log);
            if (zigbeeDevice.bridgedDevice.hasAttributeServer(Thermostat.id, 'occupiedHeatingSetpoint'))
                void zigbeeDevice.bridgedDevice.subscribeAttribute(Thermostat.id, 'occupiedHeatingSetpoint', (newValue, oldValue, context) => {
                    if (newValue === oldValue || context.fabric === undefined)
                        return;
                    zigbeeDevice.log.debug(`Subscribe occupiedHeatingSetpoint called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} with:`, newValue);
                    if (zigbeeDevice.propertyMap.has('current_heating_setpoint'))
                        zigbeeDevice.publishCommand('OccupiedHeatingSetpoint', device.friendly_name, { current_heating_setpoint: Math.round(newValue / 100) });
                    else if (zigbeeDevice.propertyMap.has('occupied_heating_setpoint'))
                        zigbeeDevice.publishCommand('OccupiedHeatingSetpoint', device.friendly_name, { occupied_heating_setpoint: Math.round(newValue / 100) });
                    zigbeeDevice.noUpdate = true;
                    zigbeeDevice.thermostatTimeout = setTimeout(() => {
                        zigbeeDevice.noUpdate = false;
                    }, zigbeeDevice.thermostatTimeoutTime).unref();
                }, zigbeeDevice.log);
            if (zigbeeDevice.bridgedDevice.hasAttributeServer(Thermostat.id, 'occupiedCoolingSetpoint'))
                void zigbeeDevice.bridgedDevice.subscribeAttribute(Thermostat.id, 'occupiedCoolingSetpoint', (newValue, oldValue, context) => {
                    if (newValue === oldValue || context.fabric === undefined)
                        return;
                    zigbeeDevice.log.debug(`Subscribe occupiedCoolingSetpoint called for ${zigbeeDevice.ien}${device.friendly_name}${rs}${db} with:`, newValue);
                    if (zigbeeDevice.propertyMap.has('current_heating_setpoint'))
                        zigbeeDevice.publishCommand('OccupiedCoolingSetpoint', device.friendly_name, { current_heating_setpoint: Math.round(newValue / 100) });
                    else if (zigbeeDevice.propertyMap.has('occupied_cooling_setpoint'))
                        zigbeeDevice.publishCommand('OccupiedCoolingSetpoint', device.friendly_name, { occupied_cooling_setpoint: Math.round(newValue / 100) });
                    zigbeeDevice.noUpdate = true;
                    zigbeeDevice.thermostatTimeout = setTimeout(() => {
                        zigbeeDevice.noUpdate = false;
                    }, zigbeeDevice.thermostatTimeoutTime).unref();
                }, zigbeeDevice.log);
        }
        return zigbeeDevice;
    }
}
