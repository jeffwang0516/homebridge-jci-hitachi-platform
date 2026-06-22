import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import JciHitachiPlatform from '../platform';
import { DEVICE_STATUS_REFRESH_INTERVAL } from '../settings';
import { JciHitachiAccessoryContext, JciHitachiAccessory } from '../types';

enum DehumidifierCommandType {
  Power = 'Switch',
  Mode = 'Mode',
  CurrentHumidity = 'IndoorHumidity',
  TargetHumidity = 'HumiditySetting',
  FanSpeed = 'FanSpeed',
}

enum DehumidifierMode {
  Auto = 0,
  Custom = 1,
  Continuous = 2,
  ClothesDry = 3,
  AirPurify = 4,
  MoldPrev = 5,
  LowHumidity = 8,
  EcoComfort = 9,
}

type DehumidifierModeKey =
  | 'auto'
  | 'custom'
  | 'continuous'
  | 'clothes_dry'
  | 'air_purify'
  | 'mold_prev'
  | 'low_humidity'
  | 'eco_comfort';

type DehumidifierModeDefinition = {
  key: DehumidifierModeKey;
  label: string;
  value: DehumidifierMode;
};

const DEHUMIDIFIER_MODES: DehumidifierModeDefinition[] = [
  { key: 'auto', label: '自動', value: DehumidifierMode.Auto },
  { key: 'custom', label: '自訂', value: DehumidifierMode.Custom },
  { key: 'continuous', label: '連續', value: DehumidifierMode.Continuous },
  { key: 'clothes_dry', label: '乾衣', value: DehumidifierMode.ClothesDry },
  { key: 'air_purify', label: '空氣淨化', value: DehumidifierMode.AirPurify },
  { key: 'mold_prev', label: '防霉', value: DehumidifierMode.MoldPrev },
  { key: 'low_humidity', label: '低濕', value: DehumidifierMode.LowHumidity },
  { key: 'eco_comfort', label: '節能舒適', value: DehumidifierMode.EcoComfort },
];

export default class DehumidifierAccessory extends JciHitachiAccessory {

  private services: Service[] = [];
  private modeSwitchServices: {[mode in DehumidifierModeKey]?: Service} = {};
  private _refreshInterval: NodeJS.Timer | undefined;

  constructor(
    protected readonly platform: JciHitachiPlatform,
    protected readonly accessory: PlatformAccessory<JciHitachiAccessoryContext>,
  ) {
    super(platform, accessory);

    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        'JciHitachi TW',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        accessory.context.device.Model || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.UUID,
      );

    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.accessory.context.device.FirmwareVersion || '0',
      );

    this.services['Dehumidifier'] = this.accessory.getService(this.platform.Service.HumidifierDehumidifier)
      || this.accessory.addService(this.platform.Service.HumidifierDehumidifier);

    this.services['Dehumidifier'].setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.CustomDeviceName || '除濕機',
    );

    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierDehumidifierState.bind(this));

    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      })
      .onGet(this.getTargetHumidifierDehumidifierState.bind(this))
      .onSet(this.setTargetHumidifierDehumidifierState.bind(this));

    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Many devices support a relative-humidity target, but the command key/value may differ by model.
    // We keep a default HomeKit range and send the value using HumiditySetting when available.
    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .setProps({
        minValue: 40,
        maxValue: 70,
        minStep: 1,
      })
      .onGet(this.getRelativeHumidityDehumidifierThreshold.bind(this))
      .onSet(this.setRelativeHumidityDehumidifierThreshold.bind(this));

    this.services['Dehumidifier']
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 6,
        minStep: 1,
      })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    for (const mode of DEHUMIDIFIER_MODES) {
      const service = this.accessory.getServiceById(this.platform.Service.Switch, DehumidifierCommandType.Mode + ':' + mode.key)
        || this.accessory.addService(this.platform.Service.Switch, mode.label, DehumidifierCommandType.Mode + ':' + mode.key);

      service.setCharacteristic(this.platform.Characteristic.Name, mode.label);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setModeSwitch.bind(this, mode))
        .onGet(this.getModeSwitch.bind(this, mode));

      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      service.setCharacteristic(this.platform.Characteristic.ConfiguredName, mode.label);

      this.modeSwitchServices[mode.key] = service;
    }

    this.refreshDeviceStatus();
  }

  async refreshDeviceStatus() {
    this.platform.log.debug(`Accessory: Refresh status for device '${this.accessory.displayName}'`);

    try {
      this.platform.jciHitachiAWSAPI.RefeshDevice(this.accessory.context.device?.ThingName || '');
    } catch (error) {
      this.platform.log.error('An error occurred while refreshing the device status. Turn on debug mode for more information.');

      if (error) {
        this.platform.log.debug(error);
      }
    }

    if (!this._refreshInterval) {
      this._refreshInterval = setInterval(
        this.refreshDeviceStatus.bind(this),
        DEVICE_STATUS_REFRESH_INTERVAL,
      );
    }
  }

  async getStatus(actionName: string): Promise<Object | undefined> {
    return this.platform.jciHitachiAWSAPI.GetDeviceStatus(this.accessory.context.device?.ThingName || '', actionName);
  }

  async setStatus(actionName: string, value: number): Promise<Object | undefined> {
    return this.platform.jciHitachiAWSAPI.SetDeviceStatus(this.accessory.context.device?.ThingName || '', actionName, value);
  }

  async setActive(value: CharacteristicValue) {
    this.platform.log.debug(`Accessory: setActive() for device '${this.accessory.displayName}'`);

    this.setStatus(DehumidifierCommandType.Power, value === this.platform.Characteristic.Active.ACTIVE ? 1 : 0);
    this.services['Dehumidifier'].updateCharacteristic(this.platform.Characteristic.Active, value);
  }

  async getActive(): Promise<CharacteristicValue> {
    return this.accessory.context.device.SwitchOn
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  async getCurrentHumidifierDehumidifierState(): Promise<CharacteristicValue> {
    const isActive = await this.getActive();

    if (isActive === this.platform.Characteristic.Active.ACTIVE) {
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
    }

    return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
  }

  async getTargetHumidifierDehumidifierState(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;
  }

  async setTargetHumidifierDehumidifierState(value: CharacteristicValue) {
    // HomeKit can only target DEHUMIDIFIER here; map it to Dry mode for compatibility.
    if (value === this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER) {
      await this.setStatus(DehumidifierCommandType.Mode, DehumidifierMode.Custom);
    }

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
    );
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    return this.accessory.context.device.IndoorHumidity || 0;
  }

  async getRelativeHumidityDehumidifierThreshold(): Promise<CharacteristicValue> {
    const humidityTarget = await this.getStatus(DehumidifierCommandType.TargetHumidity);

    if (typeof humidityTarget === 'number') {
      return humidityTarget;
    }

    // Fall back to current humidity if target is unavailable on this model.
    return this.accessory.context.device.IndoorHumidity || 50;
  }

  async setRelativeHumidityDehumidifierThreshold(value: CharacteristicValue) {
    const threshold = +value;

    this.platform.log.debug(
      `Accessory: setRelativeHumidityDehumidifierThreshold() for device '${this.accessory.displayName}' to ${threshold}`,
    );

    await this.setStatus(DehumidifierCommandType.TargetHumidity, threshold);

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.RelativeHumidityDehumidifierThreshold,
      threshold,
    );
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    return this.accessory.context.device.FanSpeed || 0;
  }

  async setRotationSpeed(value: CharacteristicValue) {
    this.setStatus(DehumidifierCommandType.FanSpeed, value as number);
    this.services['Dehumidifier'].updateCharacteristic(this.platform.Characteristic.RotationSpeed, value);
  }

  private getModeFromValue(value: number | undefined): DehumidifierModeDefinition | undefined {
    if (value === undefined) {
      return undefined;
    }

    return DEHUMIDIFIER_MODES.find(mode => mode.value === value);
  }

  private async getCurrentMode(): Promise<DehumidifierModeDefinition | undefined> {
    const modeValue = await this.getStatus(DehumidifierCommandType.Mode);

    if (typeof modeValue !== 'number') {
      return undefined;
    }

    return this.getModeFromValue(modeValue);
  }

  private async setModeSwitch(mode: DehumidifierModeDefinition, value: CharacteristicValue) {
    const isOn = value === true;

    if (isOn) {
      await this.setStatus(DehumidifierCommandType.Mode, mode.value);
      for (const currentMode of DEHUMIDIFIER_MODES) {
        this.modeSwitchServices[currentMode.key]?.updateCharacteristic(
          this.platform.Characteristic.On,
          currentMode.key === mode.key,
        );
      }
      return;
    }

    const currentMode = await this.getCurrentMode();

    if (currentMode?.key === mode.key) {
      this.modeSwitchServices[mode.key]?.updateCharacteristic(this.platform.Characteristic.On, true);
      return;
    }

    this.modeSwitchServices[mode.key]?.updateCharacteristic(this.platform.Characteristic.On, false);
  }

  private async getModeSwitch(mode: DehumidifierModeDefinition): Promise<CharacteristicValue> {
    const currentMode = await this.getCurrentMode();
    return currentMode?.key === mode.key;
  }

  public async updateStatus() {
    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.Model,
        this.accessory.context.device.Model || 'Unknown',
      );

    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.accessory.context.device.FirmwareVersion || '0',
      );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.Name,
      this.accessory.context.device.CustomDeviceName || '除濕機',
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.Active,
      this.accessory.context.device.SwitchOn || 0,
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      this.accessory.context.device.IndoorHumidity || 0,
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      await this.getCurrentHumidifierDehumidifierState(),
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.RelativeHumidityDehumidifierThreshold,
      await this.getRelativeHumidityDehumidifierThreshold(),
    );

    this.services['Dehumidifier'].updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      this.accessory.context.device.FanSpeed || 0,
    );

    const currentMode = await this.getCurrentMode();

    for (const mode of DEHUMIDIFIER_MODES) {
      this.modeSwitchServices[mode.key]?.updateCharacteristic(
        this.platform.Characteristic.On,
        currentMode?.key === mode.key,
      );
    }
  }
}
