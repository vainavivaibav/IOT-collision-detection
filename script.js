/**
 * SAFERIDE — ROBOT-CAR HARDWARE ASSEMBLY
 * Scroll-driven component visualization, live telemetry & Render cloud polling.
 */

const CONFIG = {
  API_BASE_URL: 'https://iot-collision-detection.onrender.com',
  POLL_INTERVAL_MS: 30000,
  REQUEST_TIMEOUT_MS: 9000
};

// Global Central Store
const AppStore = {
  events: [],
  filteredEvents: [],
  isApiHealthy: false,
  isPollingEvents: false,
  lastPollTimestamp: null,
  apiLatencyMs: null,

  // Rolling 30-sample inertial waveform buffer
  waveforms: {
    ax: Array(30).fill(0),
    ay: Array(30).fill(0),
    az: Array(30).fill(9.8),
    mag: Array(30).fill(9.8)
  },

  // Simulated Hardware Diagnostics State
  simState: {
    mode: 'NOMINAL',
    impactDetected: false,
    vibrationActive: false,
    delta: 0.12,
    ax: 0.05,
    ay: -0.02,
    az: 9.81
  }
};

/* ==========================================================================
   1. ROBOT-CAR HARDWARE MODEL (THREE.JS + GSAP)
   ========================================================================== */
class CinematicVehicleAssembly {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.carRoot = null;
    this.components = {};

    this.initStudio();
    this.buildRobotCar();
    this.bindScrollOrchestration();
    this.bindResize();
    this.renderLoop();
  }

  initStudio() {
    this.scene = new THREE.Scene();

    // Dynamic Studio Background reacting to Theme Engine
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.scene.background = new THREE.Color(isDark ? 0x080C14 : 0xEAF1F7);

    const aspect = this.container.clientWidth / this.container.clientHeight;
    const cameraFov = aspect < 0.8 ? 90 : 60;
    this.camera = new THREE.PerspectiveCamera(cameraFov, aspect, 0.1, 100);
    this.camera.position.set(5.2, 2.8, 6.2);
    this.camera.lookAt(0, 0.05, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Multi-Point Studio Illumination
    const ambLight = new THREE.AmbientLight(0xFFFFFF, isDark ? 0.6 : 1.2);
    this.scene.add(ambLight);

    const keyLight = new THREE.DirectionalLight(0xFFFFFF, isDark ? 1.8 : 2.4);
    keyLight.position.set(6, 8, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00CFE8, isDark ? 1.6 : 1.2);
    rimLight.position.set(-6, 3, -4);
    this.scene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0x3678F6, isDark ? 0.8 : 0.6);
    fillLight.position.set(0, -4, 4);
    this.scene.add(fillLight);

    // Ground Studio Contact Plane & Technical Coordinate Grid
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.ShadowMaterial({ opacity: isDark ? 0.4 : 0.12 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.52;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(24, 24, 0x00A6A6, isDark ? 0x1F2937 : 0xD1DCE5);
    grid.position.y = -0.51;
    this.scene.add(grid);
  }

  buildRobotCar() {
    this.carRoot = new THREE.Group();
    this.carRoot.scale.setScalar(1.5);
    this.scene.add(this.carRoot);

    const frame = new THREE.MeshStandardMaterial({ color: 0x1E293B, metalness: 0.65, roughness: 0.32 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0F172A, metalness: 0.55, roughness: 0.4 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x94A3B8, metalness: 0.8, roughness: 0.25 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.82 });
    const pcb = new THREE.MeshStandardMaterial({ color: 0x059669, metalness: 0.25, roughness: 0.45 });
    const cyan = new THREE.MeshStandardMaterial({ color: 0x00CFE8, metalness: 0.35, roughness: 0.3 });
    const amber = new THREE.MeshStandardMaterial({ color: 0xD97706, metalness: 0.3, roughness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x020617, metalness: 0.35, roughness: 0.45 });
    const gsmBoard = new THREE.MeshStandardMaterial({ color: 0xB91C1C, metalness: 0.2, roughness: 0.55 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xF59E0B, metalness: 0.75, roughness: 0.25 });

    const addBox = (parent, dimensions, material, position) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material);
      mesh.position.set(...position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const chassis = new THREE.Group();
    addBox(chassis, [2.65, 0.12, 1.35], frame, [0, 0, 0]);
    addBox(chassis, [2.75, 0.08, 0.1], metal, [0, -0.1, 0.58]);
    addBox(chassis, [2.75, 0.08, 0.1], metal, [0, -0.1, -0.58]);
    addBox(chassis, [0.12, 0.1, 1.18], metal, [0.85, -0.1, 0]);
    addBox(chassis, [0.12, 0.1, 1.18], metal, [-0.85, -0.1, 0]);
    this.components.chassis = chassis;
    this.carRoot.add(chassis);

    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 24);
    wheelGeo.rotateX(Math.PI / 2);
    const makeWheel = (x, z) => {
      const wGroup = new THREE.Group();
      const tire = new THREE.Mesh(wheelGeo, rubber);
      tire.castShadow = true;
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.25, 16), metal);
      rim.rotateX(Math.PI / 2);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.27, 12), cyan);
      hub.rotateX(Math.PI / 2);
      wGroup.add(tire, rim, hub);
      wGroup.position.set(x, -0.02, z);
      return wGroup;
    };
    this.components.wheelFL = makeWheel(0.95, 0.82);
    this.components.wheelFR = makeWheel(0.95, -0.82);
    this.components.wheelRL = makeWheel(-0.95, 0.82);
    this.components.wheelRR = makeWheel(-0.95, -0.82);
    this.carRoot.add(this.components.wheelFL, this.components.wheelFR, this.components.wheelRL, this.components.wheelRR);

    const makeMotor = (z) => {
      const motor = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 20), metal);
      barrel.rotation.x = Math.PI / 2;
      motor.add(barrel);
      addBox(motor, [0.32, 0.18, 0.16], dark, [0, -0.16, 0]);
      motor.position.set(-0.72, -0.06, z);
      return motor;
    };
    this.components.motorLeft = makeMotor(0.48);
    this.components.motorRight = makeMotor(-0.48);
    this.carRoot.add(this.components.motorLeft, this.components.motorRight);

    const battery = new THREE.Group();
    addBox(battery, [0.76, 0.28, 0.52], dark, [0, 0, 0]);
    addBox(battery, [0.32, 0.06, 0.12], amber, [-0.12, 0.17, 0]);
    battery.position.set(-0.08, 0.19, 0);
    this.components.battery = battery;
    this.carRoot.add(battery);

    const motorDriver = new THREE.Group();
    addBox(motorDriver, [0.56, 0.07, 0.42], pcb, [0, 0, 0]);
    addBox(motorDriver, [0.24, 0.2, 0.22], dark, [0, 0.13, 0]);
    for (let i = 0; i < 4; i += 1) {
      addBox(motorDriver, [0.05, 0.1, 0.06], metal, [-0.2 + i * 0.13, 0.08, 0.23]);
    }
    motorDriver.position.set(0.55, 0.2, -0.22);
    this.components.motorDriver = motorDriver;
    this.carRoot.add(motorDriver);

    const makeEsp32 = (position) => {
      const module = new THREE.Group();
      addBox(module, [0.42, 0.05, 0.3], pcb, [0, 0, 0]);
      addBox(module, [0.2, 0.04, 0.16], metal, [0, 0.045, 0]);
      addBox(module, [0.11, 0.03, 0.07], black, [0.05, 0.08, 0]);
      module.position.set(...position);
      return module;
    };
    this.components.sensorESP = makeEsp32([0.45, 0.2, 0.34]);
    this.components.gatewayESP = makeEsp32([-0.45, 0.2, -0.34]);
    this.carRoot.add(this.components.sensorESP, this.components.gatewayESP);

    const adxlNode = new THREE.Group();
    addBox(adxlNode, [0.22, 0.04, 0.2], pcb, [0, 0, 0]);
    addBox(adxlNode, [0.09, 0.04, 0.09], amber, [0, 0.04, 0]);
    adxlNode.position.set(0.92, 0.2, 0.35);
    this.components.sensorADXL = adxlNode;
    this.carRoot.add(adxlNode);

    const piezoNode = new THREE.Group();
    addBox(piezoNode, [0.2, 0.04, 0.18], pcb, [0, 0, 0]);
    const vibrationCan = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 12), cyan);
    vibrationCan.rotation.z = Math.PI / 2;
    vibrationCan.position.y = 0.05;
    piezoNode.add(vibrationCan);
    piezoNode.position.set(1.12, 0.2, 0.35);
    this.components.sensorPiezo = piezoNode;
    this.carRoot.add(piezoNode);

    const gpsNode = new THREE.Group();
    addBox(gpsNode, [0.28, 0.04, 0.24], pcb, [0, 0, 0]);
    addBox(gpsNode, [0.16, 0.06, 0.15], metal, [0, 0.05, 0]);
    gpsNode.position.set(-0.46, 0.32, -0.34);
    this.components.sensorGPS = gpsNode;
    this.carRoot.add(gpsNode);

    const gsmNode = new THREE.Group();
    addBox(gsmNode, [0.5, 0.04, 0.36], gsmBoard, [0, 0, 0]);
    addBox(gsmNode, [0.24, 0.08, 0.2], metal, [0, 0.06, 0]);
    addBox(gsmNode, [0.12, 0.025, 0.08], gold, [0.15, 0.035, 0.1]);
    for (let i = 0; i < 4; i += 1) {
      addBox(gsmNode, [0.035, 0.045, 0.035], gold, [-0.15 + i * 0.1, -0.035, 0.17]);
    }
    gsmNode.position.set(0.25, 0.3, -0.35);
    this.components.gsmModule = gsmNode;
    this.carRoot.add(gsmNode);
  }

  bindScrollOrchestration() {
    gsap.registerPlugin(ScrollTrigger);

    const titleElem = document.getElementById('assemblyStageTitle');
    const descElem = document.getElementById('assemblyStageDesc');
    const chipElem = document.getElementById('assemblyPhaseChip');
    const fillBar = document.getElementById('assemblyProgressFill');
    const labelBar = document.getElementById('assemblyProgressLabel');

    const callouts = {
      adxl: document.getElementById('calloutADXL'),
      gps: document.getElementById('calloutGPS'),
      esp: document.getElementById('calloutESP'),
      sensorESP: document.getElementById('calloutSensorESP'),
      piezo: document.getElementById('calloutPiezo'),
      cloud: document.getElementById('calloutCloud'),
      gsm: document.getElementById('calloutGSM')
    };

    const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const masterTimeline = gsap.timeline({
      scrollTrigger: {
        trigger: '#engineering',
        start: 'top top',
        end: 'bottom bottom',
        scrub: isReducedMotion ? false : 1.2,
        onUpdate: (self) => {
          const pct = Math.round(self.progress * 100);
          if (fillBar) fillBar.style.width = `${pct}%`;
          if (labelBar) labelBar.innerText = `Scroll to explore SAFERIDE hardware (${pct}%)`;

          // Synchronous Stage Title & Annotation Management
          if (self.progress < 0.20) {
            chipElem.innerText = "STAGE 1 OF 5: VEHICLE & MOTION";
            titleElem.innerText = "Stage 1: Vehicle & Motion";
            descElem.innerText = "Four-wheeled robot chassis, two DC geared motors, an L298N motor driver, and a suitable motor power supply form the moving platform.";
            Object.values(callouts).forEach(el => el?.classList.remove('active'));
          } else if (self.progress < 0.40) {
            chipElem.innerText = "STAGE 2 OF 5: COLLISION DETECTION";
            titleElem.innerText = "Stage 2: Collision Detection";
            descElem.innerText = "ESP32 #1 is the sensor node, designed to use the ADXL345 accelerometer and SW-420 vibration sensor to detect possible collisions.";
            callouts.sensorESP?.classList.add('active');
            callouts.adxl?.classList.add('active');
            callouts.piezo?.classList.add('active');
            callouts.gps?.classList.remove('active');
            callouts.esp?.classList.remove('active');
            callouts.cloud?.classList.remove('active');
            callouts.gsm?.classList.remove('active');
          } else if (self.progress < 0.60) {
            chipElem.innerText = "STAGE 3 OF 5: GATEWAY & GPS";
            titleElem.innerText = "Stage 3: Gateway & GPS";
            descElem.innerText = "ESP32 #2 is designed to receive sensor/event data over Wi-Fi and interface with the NEO-6M GPS module for location coordinates.";
            callouts.adxl?.classList.remove('active');
            callouts.gps?.classList.add('active');
            callouts.esp?.classList.add('active');
            callouts.sensorESP?.classList.remove('active');
            callouts.piezo?.classList.remove('active');
            callouts.cloud?.classList.remove('active');
            callouts.gsm?.classList.remove('active');
          } else if (self.progress < 0.80) {
            chipElem.innerText = "STAGE 4 OF 5: CLOUD MONITORING";
            titleElem.innerText = "Stage 4: Cloud Monitoring";
            descElem.innerText = "The gateway is intended to send collision events through a Wi-Fi hotspot to the existing Render Flask API and PostgreSQL database for dashboard monitoring; physical transmission is not verified.";
            callouts.adxl?.classList.remove('active');
            callouts.gps?.classList.add('active');
            callouts.esp?.classList.add('active');
            callouts.sensorESP?.classList.remove('active');
            callouts.piezo?.classList.remove('active');
            callouts.cloud?.classList.add('active');
            callouts.gsm?.classList.remove('active');
          } else {
            chipElem.innerText = "STAGE 5 OF 5: GSM EMERGENCY ALERT";
            titleElem.innerText = "Stage 5: GSM Emergency Alert";
            descElem.innerText = "A planned SIM800L module is intended to send collision and location details by SMS to a designated contact. Wiring and power must be checked with a multimeter before integration; SMS is not operational or verified.";
            callouts.adxl?.classList.remove('active');
            callouts.gps?.classList.add('active');
            callouts.esp?.classList.remove('active');
            callouts.sensorESP?.classList.remove('active');
            callouts.piezo?.classList.remove('active');
            callouts.cloud?.classList.add('active');
            callouts.gsm?.classList.add('active');
          }
        }
      }
    });

    // Separate each hardware group in the same order as the five architecture stages.
    masterTimeline
      .to(this.components.battery.position, { y: -0.75, duration: 0.14, ease: "power1.out" }, 0.02)
      .to(this.components.motorDriver.position, { y: 0.85, duration: 0.14, ease: "power1.out" }, 0.04)
      .to(this.components.motorLeft.position, { x: -1.5, y: 0.45, duration: 0.14, ease: "power1.out" }, 0.05)
      .to(this.components.motorRight.position, { x: 0.2, y: 0.75, duration: 0.14, ease: "power1.out" }, 0.05)
      .to(this.components.wheelFL.position, { x: 1.45, z: 1.3, duration: 0.12, ease: "power1.out" }, 0.08)
      .to(this.components.wheelFR.position, { x: 1.45, z: -1.3, duration: 0.12, ease: "power1.out" }, 0.08)
      .to(this.components.wheelRL.position, { x: -1.45, z: 1.3, duration: 0.12, ease: "power1.out" }, 0.08)
      .to(this.components.wheelRR.position, { x: -1.45, z: -1.3, duration: 0.12, ease: "power1.out" }, 0.08)
      .to(this.components.chassis.position, { y: -0.3, duration: 0.12, ease: "power1.out" }, 0.06)
      .to(this.components.sensorESP.position, { x: 0.65, y: 0.85, duration: 0.14, ease: "power1.out" }, 0.22)
      .to(this.components.sensorADXL.position, { x: 1.1, y: 1.05, duration: 0.14, ease: "power1.out" }, 0.24)
      .to(this.components.sensorPiezo.position, { x: 1.35, y: 0.85, z: 0.55, duration: 0.14, ease: "power1.out" }, 0.24)
      .to(this.components.gatewayESP.position, { x: -0.75, y: 1.05, duration: 0.14, ease: "power1.out" }, 0.42)
      .to(this.components.sensorGPS.position, { x: -0.6, y: 1.8, duration: 0.14, ease: "power1.out" }, 0.44)
      .to(this.components.gsmModule.position, { x: 1.3, y: 1.3, z: -0.95, duration: 0.16, ease: "power1.out" }, 0.82);
  }

  bindResize() {
    window.addEventListener('resize', () => {
      if (!this.container || !this.renderer || !this.camera) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.fov = this.camera.aspect < 0.8 ? 90 : 60;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  updateStudioTheme(isDark) {
    if (!this.scene) return;
    this.scene.background = new THREE.Color(isDark ? 0x080C14 : 0xEAF1F7);
  }

  renderLoop() {
    requestAnimationFrame(() => this.renderLoop());
    if (this.carRoot) {
      this.carRoot.rotation.y += 0.0004; // Subtle turntable drift
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/* ==========================================================================
   2. OPERATIONAL TELEMETRY, SPARKLINE CHARTS & DEMO MATRIX
   ========================================================================== */
class OperationalDashboardEngine {
  constructor() {
    this.dom = {
      headerDot: document.getElementById('headerCloudDot'),
      headerText: document.getElementById('headerCloudText'),
      badgeApi: document.getElementById('badgeApiHealth'),
      latencyVal: document.getElementById('valApiLatency'),
      totalEventsVal: document.getElementById('valTotalEvents'),
      eventCountBadge: document.getElementById('badgeEventCount'),
      sourceTag: document.getElementById('telemetrySourceTag'),
      lastSync: document.getElementById('lastSyncLabel'),
      btnRefresh: document.getElementById('btnManualRefresh'),
      btnRetry: document.getElementById('btnRetryEvents'),

      // Table Containers
      tbody: document.getElementById('eventsTableBody'),
      skeleton: document.getElementById('tableSkeleton'),
      emptyNotice: document.getElementById('tableEmptyNotice'),
      errorNotice: document.getElementById('tableErrorContainer'),
      searchInput: document.getElementById('filterSearchInput'),
      filterSelect: document.getElementById('filterTypeSelect'),
      countLabel: document.getElementById('filteredCountLabel'),

      // Live Gauges
      valAx: document.getElementById('valAx'),
      valAy: document.getElementById('valAy'),
      valAz: document.getElementById('valAz'),
      valDelta: document.getElementById('valDelta'),
      valVibration: document.getElementById('valVibration'),

      // Waveform Canvases
      canvasAx: document.getElementById('chart-accel-x'),
      canvasAy: document.getElementById('chart-accel-y'),
      canvasAz: document.getElementById('chart-accel-z'),
      canvasMag: document.getElementById('chart-magnitude'),

      // Demo Simulator Elements
      simBadge: document.getElementById('simStateBadge'),
      simText: document.getElementById('simFeedbackText'),

      // Modal
      modal: document.getElementById('eventDetailModal'),
      modalTitle: document.getElementById('modalEventTitle'),
      modalBody: document.getElementById('modalEventBody'),
      modalClose: document.getElementById('modalCloseBtn')
    };

    this.bindEvents();
    this.initWaveformLoop();
    this.initCloudPolling();
  }

  bindEvents() {
    this.dom.btnRefresh?.addEventListener('click', () => this.pollCloudEvents());
    this.dom.btnRetry?.addEventListener('click', () => this.pollCloudEvents());

    this.dom.searchInput?.addEventListener('input', () => this.applyTableFilters());
    this.dom.filterSelect?.addEventListener('change', () => this.applyTableFilters());

    this.dom.modalClose?.addEventListener('click', () => this.closeModal());
    this.dom.modal?.addEventListener('click', (e) => {
      if (e.target === this.dom.modal) this.closeModal();
    });

    // Laboratory Edge Simulation Matrix Actions (Isolated Client-Side Diagnostics)
    document.getElementById('btn-sim-normal')?.addEventListener('click', () => {
      this.triggerSimState('NOMINAL', 0.05, -0.02, 9.81, 0.12, false, "Nominal road kinematics restored (1.0g gravity vector).");
    });

    document.getElementById('btn-sim-bump')?.addEventListener('click', () => {
      this.triggerSimState('SPEED_BUMP', 0.22, 0.18, 14.50, 4.69, true, "Transient vertical shock registered by SW-420 and ADXL345.");
    });

    document.getElementById('btn-sim-collision')?.addEventListener('click', () => {
      this.triggerSimState('CRITICAL_IMPACT', 15.8, 4.2, 8.4, 16.34, true, "Acute longitudinal deceleration spike exceeded edge threshold.");
    });

    document.getElementById('btn-sim-rollover')?.addEventListener('click', () => {
      this.triggerSimState('ROLLOVER', 2.1, 15.4, -2.1, 15.54, true, "Inversion of lateral vector indicated vehicle rollover state.");
    });

    document.getElementById('btn-sim-critical')?.addEventListener('click', () => {
      this.triggerSimState('SEVERE_COMPOUND', 16.0, 15.9, 14.8, 26.96, true, "High-energy compound collision; emergency packet prioritized.");
    });

    document.getElementById('btn-sim-node-fail')?.addEventListener('click', () => {
      this.triggerSimState('NODE_FAULT', 0, 0, 0, 0, false, "Simulated CAN/I²C bus disconnection. Transducer reports null response.");
    });
  }

  triggerSimState(mode, ax, ay, az, delta, vib, desc) {
    AppStore.simState = { mode, ax, ay, az, delta, vibrationActive: vib };
    this.dom.simBadge.innerText = mode;
    this.dom.simBadge.className = `badge ${mode === 'NOMINAL' ? 'badge-normal' : 'badge-danger'}`;
    this.dom.simText.innerText = desc;

    // Direct gauge update if no cloud events exist yet
    if (AppStore.events.length === 0) {
      this.dom.valAx.innerText = ax.toFixed(2);
      this.dom.valAy.innerText = ay.toFixed(2);
      this.dom.valAz.innerText = az.toFixed(2);
      this.dom.valDelta.innerText = delta.toFixed(2);
      this.dom.valVibration.innerText = vib ? 'DETECTED' : 'IDLE';
      this.dom.sourceTag.innerText = `LOCAL SIMULATION — NOT STORED (${mode})`;
    }
  }

  initWaveformLoop() {
    setInterval(() => {
      const jitter = () => (Math.random() - 0.5) * 0.12;
      const cur = AppStore.simState;

      const nAx = cur.ax + jitter();
      const nAy = cur.ay + jitter();
      const nAz = cur.az + jitter();
      const nMag = Math.sqrt(nAx*nAx + nAy*nAy + nAz*nAz);

      AppStore.waveforms.ax.shift(); AppStore.waveforms.ax.push(nAx);
      AppStore.waveforms.ay.shift(); AppStore.waveforms.ay.push(nAy);
      AppStore.waveforms.az.shift(); AppStore.waveforms.az.push(nAz);
      AppStore.waveforms.mag.shift(); AppStore.waveforms.mag.push(nMag);

      this.drawSparkline(this.dom.canvasAx, AppStore.waveforms.ax, -16, 16, '#00A6A6');
      this.drawSparkline(this.dom.canvasAy, AppStore.waveforms.ay, -16, 16, '#00CFE8');
      this.drawSparkline(this.dom.canvasAz, AppStore.waveforms.az, -5, 25, '#D97706');
      this.drawSparkline(this.dom.canvasMag, AppStore.waveforms.mag, 0, 30, '#059669');
    }, 1000);
  }

  drawSparkline(canvas, data, min, max, strokeColor) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Baseline Reference Axis
    ctx.strokeStyle = 'rgba(21, 36, 58, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Data Curve
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.0;
    ctx.beginPath();

    data.forEach((val, i) => {
      const x = (i / (data.length - 1)) * w;
      const normalized = (val - min) / (max - min);
      const y = h - Math.max(0, Math.min(1, normalized)) * h;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  }

  initCloudPolling() {
    this.pollCloudEvents();
    setInterval(() => this.pollCloudEvents(), CONFIG.POLL_INTERVAL_MS);
  }

  async pollCloudEvents() {
    if (AppStore.isPollingEvents) return;
    AppStore.isPollingEvents = true;
    this.setLoadingState(true);
    const startTick = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${CONFIG.API_BASE_URL}/api/events?limit=50`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      const latency = Math.round(performance.now() - startTick);
      AppStore.apiLatencyMs = latency;

      if (!response.ok) throw new Error(`API error HTTP ${response.status}`);

      const data = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !Number.isInteger(data.count) ||
        data.count < 0 ||
        !Array.isArray(data.events) ||
        data.count !== data.events.length ||
        data.events.some(event => !event || typeof event !== 'object' || Array.isArray(event))
      ) {
        throw new Error('Invalid response from events endpoint');
      }

      AppStore.isApiHealthy = true;
      AppStore.lastPollTimestamp = new Date();
      AppStore.events = data.events;

      this.updateStatusPills(true, latency);
      this.applyTableFilters();
      this.updateGaugesFromLatestCloudRecord();
      this.dom.lastSync.innerText = `Synced ${AppStore.lastPollTimestamp.toLocaleTimeString()}`;

    } catch (err) {
      const error = err.name === 'AbortError'
        ? new Error(`Events request timed out after ${CONFIG.REQUEST_TIMEOUT_MS / 1000} seconds`)
        : err;
      console.warn('[SAFERIDE Telemetry] API Communication Warning:', error);
      AppStore.isApiHealthy = false;
      this.updateStatusPills(false, null);
      this.dom.lastSync.innerText = AppStore.lastPollTimestamp
        ? `Refresh failed · Last successful sync ${AppStore.lastPollTimestamp.toLocaleTimeString()}`
        : 'Refresh failed · No successful sync yet';
      this.showErrorNotice(error.message);
    } finally {
      clearTimeout(timeoutId);
      AppStore.isPollingEvents = false;
      this.setLoadingState(false);
    }
  }

  updateStatusPills(isHealthy, latency) {
    if (isHealthy) {
      this.dom.headerDot.className = "status-indicator-dot online";
      this.dom.headerText.innerText = "API ONLINE";
      this.dom.badgeApi.className = "stat-indicator-pill pill-emerald";
      this.dom.badgeApi.innerText = "Events API available";
      this.dom.latencyVal.innerText = `${latency} ms`;
    } else {
      this.dom.headerDot.className = "status-indicator-dot offline";
      this.dom.headerText.innerText = "API OFFLINE";
      this.dom.badgeApi.className = "stat-indicator-pill pill-rose";
      this.dom.badgeApi.innerText = "Events API unavailable";
      this.dom.latencyVal.innerText = "-- ms";
    }
  }

  updateGaugesFromLatestCloudRecord() {
    const total = AppStore.events.length;
    this.dom.totalEventsVal.innerText = total;
    this.dom.eventCountBadge.innerText = `${total} returned`;

    if (total === 0) {
      this.dom.sourceTag.innerText = 'No stored events returned';
      this.dom.valAx.innerText = '--';
      this.dom.valAy.innerText = '--';
      this.dom.valAz.innerText = '--';
      this.dom.valDelta.innerText = '--';
      this.dom.valVibration.innerText = '--';
      return;
    }

    const latest = AppStore.events[0];
    this.dom.sourceTag.innerText = `Latest returned event #${latest.id ?? 'N/A'}`;
    this.dom.valAx.innerText = this.formatNumber(latest.x);
    this.dom.valAy.innerText = this.formatNumber(latest.y);
    this.dom.valAz.innerText = this.formatNumber(latest.z);
    this.dom.valDelta.innerText = this.formatNumber(latest.delta);
    this.dom.valVibration.innerText = this.formatVibration(latest.vibration);
  }

  formatNumber(value, digits = 2) {
    const number = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(number)
      ? number.toFixed(digits)
      : '--';
  }

  formatVibration(value) {
    if (value === null || value === undefined || value === '') return '--';
    const vibration = Number(value);
    return Number.isFinite(vibration) ? vibration !== 0 ? 'DETECTED' : 'NONE' : '--';
  }

  formatTimestamp(value) {
    if (typeof value !== 'string' || !value) return '--';
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime())
      ? '--'
      : timestamp.toISOString().replace('T', ' ').slice(0, 19);
  }

  escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  hasCoordinates(item) {
    if (
      item.latitude === null ||
      item.latitude === undefined ||
      item.latitude === '' ||
      item.longitude === null ||
      item.longitude === undefined ||
      item.longitude === ''
    ) {
      return false;
    }

    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    return Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      !(latitude === 0 && longitude === 0);
  }

  applyTableFilters() {
    const term = (this.dom.searchInput?.value || '').toLowerCase().trim();
    const type = this.dom.filterSelect?.value || 'ALL';

    AppStore.filteredEvents = AppStore.events.filter(item => {
      const matchType = (type === 'ALL') || (item.event_type === type);
      const strContent = `${item.id} ${item.event_type} ${item.latitude} ${item.longitude} ${item.x} ${item.y} ${item.z} ${item.received_at}`.toLowerCase();
      const matchTerm = !term || strContent.includes(term);
      return matchType && matchTerm;
    });

    this.renderEventsTable();
  }

  renderEventsTable() {
    this.dom.tbody.innerHTML = '';
    const records = AppStore.filteredEvents;

    this.dom.countLabel.innerText = `Showing ${records.length} of ${AppStore.events.length} returned events`;

    if (records.length === 0) {
      this.dom.emptyNotice.classList.remove('hidden');
      this.dom.errorNotice?.classList.add('hidden');
      return;
    }

    this.dom.emptyNotice.classList.add('hidden');
    this.dom.errorNotice.classList.add('hidden');

    records.forEach(item => {
      const tr = document.createElement('tr');
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const hasCoords = this.hasCoordinates(item);
      const coordHtml = hasCoords
        ? `<a href="https://www.google.com/maps?q=${latitude},${longitude}" target="_blank" rel="noopener noreferrer" style="color:var(--brand-teal);text-decoration:none;font-weight:600;">${latitude.toFixed(4)}, ${longitude.toFixed(4)} ↗</a>`
        : `<span style="color:var(--text-muted);">No Lock</span>`;

      tr.innerHTML = `
        <td><strong>#${this.escapeHTML(item.id ?? '--')}</strong></td>
        <td><span class="chip ${item.event_type === 'POSSIBLE_COLLISION' ? 'chip-teal' : 'chip-dim'}">${this.escapeHTML(item.event_type ?? 'INCIDENT')}</span></td>
        <td>${this.formatTimestamp(item.received_at)}</td>
        <td>${this.formatNumber(item.x)}, ${this.formatNumber(item.y)}, ${this.formatNumber(item.z)}</td>
        <td>${this.formatNumber(item.delta)}</td>
        <td>${this.formatVibration(item.vibration) === 'DETECTED' ? '<span style="color:var(--accent-amber);font-weight:600;">DETECTED</span>' : this.formatVibration(item.vibration)}</td>
        <td>${coordHtml}</td>
        <td><button class="btn btn-secondary btn-sm btn-inspect" data-id="${this.escapeHTML(item.id ?? '')}">Inspect</button></td>
      `;

      tr.querySelector('.btn-inspect').addEventListener('click', () => this.openModal(item));
      this.dom.tbody.appendChild(tr);
    });
  }

  setLoadingState(isLoading) {
    if (this.dom.btnRefresh) this.dom.btnRefresh.disabled = isLoading;
    if (this.dom.btnRetry) this.dom.btnRetry.disabled = isLoading;
    if (isLoading && AppStore.events.length === 0) {
      this.dom.skeleton?.classList.remove('hidden');
      this.dom.emptyNotice?.classList.add('hidden');
      this.dom.errorNotice?.classList.add('hidden');
    } else {
      this.dom.skeleton?.classList.add('hidden');
    }
  }

  showErrorNotice(msg) {
    this.dom.errorNotice?.classList.remove('hidden');
    const msgElem = document.getElementById('errorNoticeMsg');
    if (msgElem) {
      const cachedEvents = AppStore.events.length > 0
        ? ' Showing the last successfully retrieved events.'
        : '';
      msgElem.innerText = `Could not refresh events: ${msg}.${cachedEvents}`;
    }
  }

  openModal(item) {
    this.dom.modalTitle.innerText = `Incident Telemetry: Record #${item.id || 'N/A'}`;
    this.dom.modalBody.innerHTML = `
      <p>Received at (UTC): ${this.formatTimestamp(item.received_at)}</p>
      <p>Acceleration: X ${this.formatNumber(item.x)}, Y ${this.formatNumber(item.y)}, Z ${this.formatNumber(item.z)}</p>
      <p>Vibration: ${item.vibration == null || !Number.isFinite(Number(item.vibration)) ? '--' : Number(item.vibration) !== 0 ? 'DETECTED' : 'NONE'} · Delta: ${this.formatNumber(item.delta)}</p>
      <pre style="background:var(--bg-elevated);padding:16px;border-radius:6px;overflow-x:auto;color:var(--text-main);">${this.escapeHTML(JSON.stringify(item, null, 2))}</pre>
      <div style="margin-top:16px;display:flex;gap:12px;">
        ${this.hasCoordinates(item) ? `<a href="https://www.google.com/maps?q=${Number(item.latitude)},${Number(item.longitude)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">View GPS on Map</a>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('eventDetailModal').classList.add('hidden')">Close Inspector</button>
      </div>
    `;
    this.dom.modal.classList.remove('hidden');
  }

  closeModal() {
    this.dom.modal.classList.add('hidden');
  }
}

/* ==========================================================================
   3. THEME MANAGEMENT & LIFECYCLE BOOTSTRAP
   ========================================================================== */
function setupThemeManager(vehicleApp) {
  const toggleBtn = document.getElementById('themeToggleBtn');
  const toggleIcon = document.getElementById('themeToggleIcon');
  const savedTheme = localStorage.getItem('vg_theme') || 'light';

  document.documentElement.setAttribute('data-theme', savedTheme);
  if (toggleIcon) toggleIcon.innerText = savedTheme === 'dark' ? '☀️' : '🌙';

  toggleBtn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('vg_theme', next);
    if (toggleIcon) toggleIcon.innerText = next === 'dark' ? '☀️' : '🌙';
    vehicleApp.updateStudioTheme(next === 'dark');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const vehicleApp = new CinematicVehicleAssembly('three-canvas-container');
  setupThemeManager(vehicleApp);
  new OperationalDashboardEngine();
});