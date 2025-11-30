import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    PHYSICS_CONFIG,
    PhysicsConstants,
    BallState,
    updateBallPhysics,
    calculateBallCollision,
    calculateCushionRebound,
    applyShot,
    getBallDiagnostics
} from './physics.js';

// Loading progress helper
function updateLoadingProgress(percent, status) {
    const progressBar = document.getElementById('loading-progress');
    const percentText = document.getElementById('loading-percent');
    const statusText = document.getElementById('loading-status');
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (percentText) percentText.textContent = `${Math.round(percent)}%`;
    if (statusText && status) statusText.textContent = status;
}

// IndexedDB cache for GLB model
const MODEL_CACHE_NAME = 'snooker-model-cache';
const MODEL_CACHE_VERSION = 1;

async function getCachedModel(url) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);

        request.onerror = () => resolve(null);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('models')) {
                db.createObjectStore('models', { keyPath: 'url' });
            }
        };

        request.onsuccess = (event) => {
            const db = event.target.result;
            try {
                const transaction = db.transaction(['models'], 'readonly');
                const store = transaction.objectStore('models');
                const getRequest = store.get(url);

                getRequest.onsuccess = () => {
                    if (getRequest.result) {
                        resolve(getRequest.result.data);
                    } else {
                        resolve(null);
                    }
                };
                getRequest.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        };
    });
}

async function cacheModel(url, arrayBuffer) {
    return new Promise((resolve) => {
        const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);

        request.onerror = () => resolve();

        request.onsuccess = (event) => {
            const db = event.target.result;
            try {
                const transaction = db.transaction(['models'], 'readwrite');
                const store = transaction.objectStore('models');
                store.put({ url, data: arrayBuffer, timestamp: Date.now() });
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        };
    });
}

// Game constants - Snooker table dimensions (12-foot table)
// Full size snooker table: 3569mm x 1778mm (playing area)
// But the model's green cloth area is smaller - cushions take space
const CUSHION_RAIL_WIDTH = 0.05; // Width of green cushion rail
const TABLE_LENGTH = 3.569 - CUSHION_RAIL_WIDTH * 2;  // Playing area length
const TABLE_WIDTH = 1.778 - CUSHION_RAIL_WIDTH * 2;   // Playing area width
const TABLE_HEIGHT = 0.05;
const TABLE_SURFACE_Y = 0.86; // Height of table surface from GLB model
const TABLE_CENTER_X = 0.1;   // X offset of table center in GLB model
const TABLE_CENTER_Z = -1.88; // Z offset of table center in GLB model

// Use physics module constants for ball properties
const BALL_RADIUS = PhysicsConstants.BALL_RADIUS;
const BALL_MASS = PhysicsConstants.BALL_MASS;
const CUSHION_HEIGHT = 0.05;
const CUSHION_WIDTH = 0.08;
const POCKET_RADIUS = 0.044; // Base radius - actual openings defined below

// Snooker ball colors and values
const SNOOKER_BALLS = {
    CUE: { color: 0xFFFFFF, value: 0, name: 'Cue' },
    RED: { color: 0xCC0000, value: 1, name: 'Red' },
    YELLOW: { color: 0xFFD700, value: 2, name: 'Yellow' },
    GREEN: { color: 0x228B22, value: 3, name: 'Green' },
    BROWN: { color: 0x8B4513, value: 4, name: 'Brown' },
    BLUE: { color: 0x0066CC, value: 5, name: 'Blue' },
    PINK: { color: 0xFF69B4, value: 6, name: 'Pink' },
    BLACK: { color: 0x111111, value: 7, name: 'Black' }
};

// Snooker color ball positions (on the baulk line and spots)
const COLOR_POSITIONS = {
    YELLOW: { x: -TABLE_WIDTH / 4 + 0.29, z: -TABLE_LENGTH / 2 + 0.737 }, // Left of D
    GREEN: { x: -TABLE_WIDTH / 4 - 0.29, z: -TABLE_LENGTH / 2 + 0.737 },  // Right of D
    BROWN: { x: -TABLE_WIDTH / 4, z: -TABLE_LENGTH / 2 + 0.737 },         // Center of baulk line
    BLUE: { x: 0, z: 0 },                                              // Center spot
    PINK: { x: TABLE_WIDTH / 4 - 0.1, z: 0 },                           // Between center and top
    BLACK: { x: TABLE_WIDTH / 2 - 0.324, z: 0 }                         // Near top cushion
};

class BilliardGame {
    constructor() {
        this.balls = [];
        this.ballBodies = [];
        this.pocketedBalls = [];
        this.cueBall = null;
        this.cueBallBody = null;
        this.cueStick = null;
        this.isAiming = false;
        this.shotPower = 0;
        this.maxPower = 15;
        this.score = 0;
        this.shots = 0;
        this.canShoot = true;
        this.aimLine = null;
        this.mouseStart = new THREE.Vector2();
        this.mouseCurrent = new THREE.Vector2();
        this.aimSensitivity = 0.15; // Lower = more precise aiming (0.1-1.0)
        this.resetting = false; // Flag to prevent pocket checking during reset

        // Snooker game state
        this.currentPlayer = 1;
        this.player1Score = 0;
        this.player2Score = 0;
        this.redsRemaining = 15;
        this.mustPotColor = false; // After potting red, must pot a color
        this.targetBall = 'RED'; // Current target (RED or specific color)
        this.foulPoints = 0;
        this.colorBallsData = {}; // Store color ball references for re-spotting
        this.pendingRespots = []; // Queue for color balls waiting to be respotted

        // Smooth camera movement
        this.cameraVelocity = new THREE.Vector3();
        this.cameraTargetPosition = new THREE.Vector3();
        this.cameraLookAtTarget = new THREE.Vector3();
        this.cameraSmoothness = 0.08;
        this.wasMoving = false;
        this.hasCameraTarget = false;

        // Physics tracking
        this.collisionLog = [];
        this.lastShotPower = 0;
        this.lastMaxSpeed = 0;
        this.currentMaxSpeed = 0;
        this.ballPhysicsData = {}; // Track physics for each ball
        this.lastBallVelocities = {}; // Track velocities for cushion detection
        this.lastCollisions = {}; // Track collision timing

        // Ball physics states (from physics.js module)
        this.ballStates = {}; // Map ball index to BallState objects

        // Spin control - values from -1 to 1
        this.spinX = 0; // Left/right english (-1 = left, 1 = right)
        this.spinY = 0; // Top/back spin (-1 = backspin, 1 = topspin)

        // Enhanced physics logging
        this.physicsLog = []; // Detailed physics events
        this.trajectoryLog = []; // Ball trajectories per shot
        this.currentShotId = 0;
        this.shotTrajectories = {}; // Track all ball positions during shot
        this.isTrackingShot = false;
        this.shotStartTimestamp = 0;

        this.init();
    }

    async init() {
        // Initialize Rapier physics
        updateLoadingProgress(5, 'Initializing physics engine...');
        await RAPIER.init();
        updateLoadingProgress(10, 'Physics ready');

        // Create physics world with optimized settings for snooker
        // Use new API format to avoid deprecation warning
        const gravity = new RAPIER.Vector3(0.0, -9.81, 0.0);
        this.world = new RAPIER.World(gravity);
        this.world.integrationParameters.dt = 1 / 480; // 8 substeps at 60fps = 1/60 total
        this.world.integrationParameters.numSolverIterations = 8; // More iterations for stable stacking
        this.world.integrationParameters.numAdditionalFrictionIterations = 4;

        // Setup Three.js
        updateLoadingProgress(15, 'Setting up renderer...');
        this.setupRenderer();
        this.setupScene();
        this.setupLights();
        this.setupCamera();
        this.setupControls();

        // Create game objects (table loading is async with progress)
        updateLoadingProgress(20, 'Loading table model...');
        await this.createTable();

        updateLoadingProgress(95, 'Creating balls...');
        this.createBalls();
        this.createCueStick();
        this.createAimLine();

        // Setup input handlers
        this.setupInputHandlers();

        updateLoadingProgress(100, 'Ready!');

        // Hide loading screen with slight delay for smooth transition
        setTimeout(() => {
            document.getElementById('loading').style.display = 'none';
        }, 200);

        // Start game loop
        this.animate();
    }

    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        document.getElementById('game-container').appendChild(this.renderer.domElement);
    }

    setupScene() {
        this.scene = new THREE.Scene();

        // Create beautiful gradient sky with sunset/sunrise colors
        this.createSkyEnvironment();
    }

    createSkyEnvironment() {
        // Elegant club atmosphere - deep, rich, sophisticated
        const skyGeometry = new THREE.SphereGeometry(50, 64, 64);

        // Custom shader for luxurious snooker club ambiance
        const skyMaterial = new THREE.ShaderMaterial({
            uniforms: {
                topColor: { value: new THREE.Color(0x0a0a12) },       // Almost black with hint of blue
                midColor1: { value: new THREE.Color(0x1a1520) },      // Deep burgundy-black
                midColor2: { value: new THREE.Color(0x2a1f28) },      // Rich dark mahogany
                horizonColor: { value: new THREE.Color(0x3d2830) },   // Warm dark wood tone
                accentColor: { value: new THREE.Color(0x4a3328) },    // Subtle amber accent
                lampColor: { value: new THREE.Color(0xffd699) },      // Warm lamp glow
                lampPosition: { value: new THREE.Vector3(0.0, 0.95, 0.0) }, // Above table
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 midColor1;
                uniform vec3 midColor2;
                uniform vec3 horizonColor;
                uniform vec3 accentColor;
                uniform vec3 lampColor;
                uniform vec3 lampPosition;
                
                varying vec3 vWorldPosition;
                
                // Smooth noise function for subtle variation
                float hash(vec2 p) {
                    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
                }
                
                float noise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    return mix(
                        mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
                        f.y
                    );
                }
                
                void main() {
                    vec3 viewDirection = normalize(vWorldPosition);
                    float height = viewDirection.y;
                    
                    // Smooth gradient - elegant club ceiling to walls
                    vec3 skyColor;
                    float t = height * 0.5 + 0.5;
                    
                    // Ultra-smooth gradient transitions
                    if (t > 0.65) {
                        // Ceiling area - darkest
                        float blend = smoothstep(0.65, 0.95, t);
                        skyColor = mix(midColor1, topColor, blend);
                    } else if (t > 0.5) {
                        // Upper walls
                        float blend = smoothstep(0.5, 0.65, t);
                        skyColor = mix(midColor2, midColor1, blend);
                    } else if (t > 0.35) {
                        // Mid walls - warmest area
                        float blend = smoothstep(0.35, 0.5, t);
                        skyColor = mix(horizonColor, midColor2, blend);
                    } else {
                        // Lower area - subtle warm accent
                        float blend = smoothstep(0.2, 0.35, t);
                        skyColor = mix(accentColor, horizonColor, blend);
                    }
                    
                    // Add subtle texture variation - wood paneling feel
                    float panelNoise = noise(viewDirection.xz * 8.0) * 0.03;
                    skyColor += vec3(panelNoise * 0.5, panelNoise * 0.3, panelNoise * 0.2);
                    
                    // Warm overhead lamp glow - subtle pool of light
                    vec3 lampDir = normalize(lampPosition);
                    float lampDot = dot(viewDirection, lampDir);
                    float lampGlow = pow(max(0.0, lampDot), 32.0) * 0.15;
                    float lampHalo = pow(max(0.0, lampDot), 4.0) * 0.08;
                    
                    skyColor += lampColor * lampGlow;
                    skyColor += lampColor * lampHalo * 0.4;
                    
                    // Very subtle vignette darkening at edges
                    float vignette = 1.0 - pow(abs(height), 3.0) * 0.2;
                    skyColor *= vignette;
                    
                    // Subtle warm color grading
                    skyColor.r *= 1.05;
                    skyColor.b *= 0.95;
                    
                    gl_FragColor = vec4(skyColor, 1.0);
                }
            `,
            side: THREE.BackSide
        });

        const sky = new THREE.Mesh(skyGeometry, skyMaterial);
        this.scene.add(sky);
        this.skyMaterial = skyMaterial;

        // Subtle fog for intimate atmosphere
        this.scene.fog = new THREE.FogExp2(0x1a1518, 0.015);
    }

    setupLights() {
        // Intimate club ambient - very subtle
        const ambient = new THREE.AmbientLight(0x2a2025, 0.3);
        this.scene.add(ambient);

        // Hemisphere light - dark ceiling, warm floor reflection
        const hemiLight = new THREE.HemisphereLight(0x1a1520, 0x3d2a25, 0.2);
        this.scene.add(hemiLight);

        // Main table lamp - warm, focused pool of light
        const mainLight = new THREE.SpotLight(0xffeedd, 2.5, 8, Math.PI / 4, 0.5, 1.5);
        mainLight.position.set(TABLE_CENTER_X, TABLE_SURFACE_Y + 2.5, TABLE_CENTER_Z);
        mainLight.target.position.set(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
        mainLight.castShadow = true;
        mainLight.shadow.mapSize.width = 2048;
        mainLight.shadow.mapSize.height = 2048;
        mainLight.shadow.camera.near = 0.5;
        mainLight.shadow.camera.far = 8;
        mainLight.shadow.bias = -0.0001;
        this.scene.add(mainLight);
        this.scene.add(mainLight.target);

        // Secondary table lights - softer fill
        const fillLight1 = new THREE.SpotLight(0xffe8cc, 0.8, 6, Math.PI / 3, 0.6, 1.5);
        fillLight1.position.set(TABLE_CENTER_X - 1, TABLE_SURFACE_Y + 2, TABLE_CENTER_Z - 1);
        fillLight1.target.position.set(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
        this.scene.add(fillLight1);
        this.scene.add(fillLight1.target);

        const fillLight2 = new THREE.SpotLight(0xffe8cc, 0.8, 6, Math.PI / 3, 0.6, 1.5);
        fillLight2.position.set(TABLE_CENTER_X + 1, TABLE_SURFACE_Y + 2, TABLE_CENTER_Z + 1);
        fillLight2.target.position.set(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
        this.scene.add(fillLight2);
        this.scene.add(fillLight2.target);

        // Subtle rim light for ball definition
        const rimLight = new THREE.DirectionalLight(0xffd4aa, 0.3);
        rimLight.position.set(3, 2, -3);
        this.scene.add(rimLight);
    }

    setupCamera() {
        this.camera = new THREE.PerspectiveCamera(
            45,
            window.innerWidth / window.innerHeight,
            0.1,
            200
        );
        // Widok z góry na cały stół - kamera PROSTO nad stołem (polar angle = 0)
        // Wysokość dobrana tak, żeby cały stół był widoczny
        this.camera.position.set(TABLE_CENTER_X, TABLE_SURFACE_Y + 4.5, TABLE_CENTER_Z + 0.01);
        this.camera.lookAt(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
    }

    setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 0.3;  // Większe zbliżenie
        this.controls.maxDistance = 15;
        // Usuń ograniczenia kąta - pełna swoboda obracania
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = Math.PI; // Pełny zakres pionowy
        this.controls.minAzimuthAngle = -Infinity; // Bez ograniczeń poziomych
        this.controls.maxAzimuthAngle = Infinity;
        this.controls.target.set(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
        this.controls.mouseButtons = {
            LEFT: null,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE
        };
        this.controls.enablePan = true;
        this.controls.panSpeed = 1.0;
        this.controls.screenSpacePanning = true;
    }

    createClothMaterial() {
        // Create premium snooker baize texture
        const canvas = document.createElement('canvas');
        const size = 512;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Noble, deep tournament green - Strachan No.10 championship cloth
        const baseR = 0;
        const baseG = 102;
        const baseB = 51;

        // Fill with solid base
        ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
        ctx.fillRect(0, 0, size, size);

        // Create elegant twill weave pattern
        for (let y = 0; y < size; y += 2) {
            for (let x = 0; x < size; x += 2) {
                // Diagonal twill weave for luxurious look
                const weavePhase = ((Math.floor(x / 2) + Math.floor(y / 2)) % 3);
                let brightness = 0;
                if (weavePhase === 0) brightness = 5;
                else if (weavePhase === 1) brightness = -3;
                else brightness = 1;

                const r = baseR;
                const g = Math.max(0, Math.min(255, baseG + brightness));
                const b = Math.max(0, Math.min(255, baseB + brightness * 0.6));

                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(x, y, 2, 2);
            }
        }

        // Subtle satin sheen gradient (nap direction)
        const gradient = ctx.createLinearGradient(0, 0, size * 0.3, size);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.015)');
        gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.008)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.012)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        // Create texture
        const clothTexture = new THREE.CanvasTexture(canvas);
        clothTexture.wrapS = THREE.RepeatWrapping;
        clothTexture.wrapT = THREE.RepeatWrapping;
        clothTexture.repeat.set(10, 5);
        clothTexture.anisotropy = 16;
        clothTexture.minFilter = THREE.LinearMipmapLinearFilter;
        clothTexture.magFilter = THREE.LinearFilter;

        // Refined normal map for soft cloth texture
        const normalCanvas = document.createElement('canvas');
        normalCanvas.width = 256;
        normalCanvas.height = 256;
        const nCtx = normalCanvas.getContext('2d');

        // Base normal (flat)
        nCtx.fillStyle = '#8080ff';
        nCtx.fillRect(0, 0, 256, 256);

        // Subtle diagonal weave bumps
        for (let y = 0; y < 256; y += 2) {
            for (let x = 0; x < 256; x += 2) {
                const weavePhase = ((Math.floor(x / 2) + Math.floor(y / 2)) % 3);
                const bump = weavePhase === 0 ? 3 : (weavePhase === 1 ? -2 : 0);

                const nx = 128 + bump * 0.7;
                const ny = 128 + bump;

                nCtx.fillStyle = `rgb(${nx}, ${ny}, 255)`;
                nCtx.fillRect(x, y, 2, 2);
            }
        }

        const normalTexture = new THREE.CanvasTexture(normalCanvas);
        normalTexture.wrapS = THREE.RepeatWrapping;
        normalTexture.wrapT = THREE.RepeatWrapping;
        normalTexture.repeat.set(20, 10);

        // Premium cloth material with subtle sheen
        const clothMaterial = new THREE.MeshStandardMaterial({
            map: clothTexture,
            normalMap: normalTexture,
            normalScale: new THREE.Vector2(0.04, 0.04),
            roughness: 0.82,
            metalness: 0.0,
            color: 0xffffff,
        });

        return clothMaterial;
    }

    async createTable() {
        // Create procedural cloth texture
        const clothMaterial = this.createClothMaterial();

        // Load GLB model with caching
        const modelUrl = 'models/tables/snooker_t.glb';
        const loader = new GLTFLoader();

        // Try to load from IndexedDB cache first
        const cachedData = await getCachedModel(modelUrl);

        if (cachedData) {
            updateLoadingProgress(50, 'Loading from cache...');
            // Parse cached ArrayBuffer
            await new Promise((resolve, reject) => {
                loader.parse(cachedData, '', (gltf) => {
                    this.setupTableModel(gltf.scene, clothMaterial);
                    updateLoadingProgress(90, 'Table loaded from cache');
                    resolve();
                }, reject);
            });
        } else {
            // Load fresh and cache
            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', modelUrl, true);
                xhr.responseType = 'arraybuffer';

                xhr.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percent = 20 + (event.loaded / event.total) * 65;
                        const loadedMB = (event.loaded / 1024 / 1024).toFixed(1);
                        const totalMB = (event.total / 1024 / 1024).toFixed(1);
                        updateLoadingProgress(percent, `Downloading table: ${loadedMB}/${totalMB} MB`);
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        const arrayBuffer = xhr.response;

                        // Cache for next time
                        updateLoadingProgress(88, 'Caching model...');
                        await cacheModel(modelUrl, arrayBuffer);

                        // Parse the model
                        updateLoadingProgress(90, 'Processing model...');
                        loader.parse(arrayBuffer, '', (gltf) => {
                            this.setupTableModel(gltf.scene, clothMaterial);
                            resolve();
                        }, reject);
                    } else {
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };

                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send();
            });
        }

        // Physics body for table surface at correct height
        // Note: model is rotated 90deg, so WIDTH is along X, LENGTH is along Z
        const tableBodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(TABLE_CENTER_X, TABLE_SURFACE_Y, TABLE_CENTER_Z);
        const tableBody = this.world.createRigidBody(tableBodyDesc);
        const tableColliderDesc = RAPIER.ColliderDesc.cuboid(
            TABLE_WIDTH / 2,
            0.01,
            TABLE_LENGTH / 2
        ).setRestitution(0.3).setFriction(0.0); // ZERO friction - we handle rolling resistance ourselves
        this.world.createCollider(tableColliderDesc, tableBody);

        // Physics cushions (walls) - positioned so inner face is at table edge
        const cushionHeight = 0.15;
        const cushionThickness = 0.5; // Thicker (0.5m half-extent = 1m total) to prevent tunneling
        const cushionRestitution = 0.92;
        const cushionFriction = 0.0; // ZERO friction - we handle cushion response ourselves

        // Pocket gaps - areas where there's no cushion
        // Zwiększone przerwy dla kieszeni - muszą być większe niż promień kieszeni + promień bili
        const cornerGap = 0.10; // 10cm przerwa w rogu (większa niż kieszeń)
        const middleGap = 0.12; // 12cm przerwa na środku (dla środkowych kieszeni)

        // Long cushions (along Z axis) - split for middle pockets
        const longSegmentLength = (TABLE_LENGTH / 2 - middleGap / 2 - cornerGap);

        // Calculate cushion positions - inner face at table edge
        // cushionThickness is half-extent, so center is at Edge + cushionThickness
        const rightCushionX = TABLE_CENTER_X + TABLE_WIDTH / 2 + cushionThickness;
        const leftCushionX = TABLE_CENTER_X - TABLE_WIDTH / 2 - cushionThickness;
        const frontCushionZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 + cushionThickness;
        const backCushionZ = TABLE_CENTER_Z - TABLE_LENGTH / 2 - cushionThickness;

        // Right cushion front part (positive X side)
        // NOTE: Set restitution to 0 - we handle cushion physics ourselves in calculateCushionRebound
        const rightFrontCushion = RAPIER.ColliderDesc.cuboid(cushionThickness, cushionHeight, longSegmentLength / 2)
            .setTranslation(
                rightCushionX,
                TABLE_SURFACE_Y + cushionHeight,
                TABLE_CENTER_Z + (TABLE_LENGTH / 4 + cornerGap / 2 + middleGap / 4)
            )
            .setRestitution(0.0) // Zero - custom physics handles this
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(rightFrontCushion, tableBody);

        // Right cushion back part
        const rightBackCushion = RAPIER.ColliderDesc.cuboid(cushionThickness, cushionHeight, longSegmentLength / 2)
            .setTranslation(
                rightCushionX,
                TABLE_SURFACE_Y + cushionHeight,
                TABLE_CENTER_Z - (TABLE_LENGTH / 4 + cornerGap / 2 + middleGap / 4)
            )
            .setRestitution(0.0)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(rightBackCushion, tableBody);

        // Left cushion front part (negative X side)
        const leftFrontCushion = RAPIER.ColliderDesc.cuboid(cushionThickness, cushionHeight, longSegmentLength / 2)
            .setTranslation(
                leftCushionX,
                TABLE_SURFACE_Y + cushionHeight,
                TABLE_CENTER_Z + (TABLE_LENGTH / 4 + cornerGap / 2 + middleGap / 4)
            )
            .setRestitution(0.0)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(leftFrontCushion, tableBody);

        // Left cushion back part
        const leftBackCushion = RAPIER.ColliderDesc.cuboid(cushionThickness, cushionHeight, longSegmentLength / 2)
            .setTranslation(
                leftCushionX,
                TABLE_SURFACE_Y + cushionHeight,
                TABLE_CENTER_Z - (TABLE_LENGTH / 4 + cornerGap / 2 + middleGap / 4)
            )
            .setRestitution(0.0)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(leftBackCushion, tableBody);

        // Short cushions (along X axis) - full width minus corner gaps
        const shortCushionLength = (TABLE_WIDTH - cornerGap * 2) / 2;

        // Front cushion (positive Z side - baulk end)
        const frontCushion = RAPIER.ColliderDesc.cuboid(shortCushionLength, cushionHeight, cushionThickness)
            .setTranslation(
                TABLE_CENTER_X,
                TABLE_SURFACE_Y + cushionHeight,
                frontCushionZ
            )
            .setRestitution(0.0)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(frontCushion, tableBody);

        // Back cushion (negative Z side - black end)
        const backCushion = RAPIER.ColliderDesc.cuboid(shortCushionLength, cushionHeight, cushionThickness)
            .setTranslation(
                TABLE_CENTER_X,
                TABLE_SURFACE_Y + cushionHeight,
                backCushionZ
            )
            .setRestitution(0.0)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFriction(cushionFriction);
        this.world.createCollider(backCushion, tableBody);

        // DEBUG: Visualize cushion boundaries with lines
        this.createCushionDebugLines();

        // Store pocket positions for ball detection
        // Corner pockets are larger and positioned at actual corners
        // Middle pockets are smaller and on the long sides
        // Real snooker pocket openings: corner ~89mm, middle ~105mm
        // Detection: ball center must be within this radius of pocket center
        const cornerPocketRadius = 0.0445; // 44.5mm (połowa otworu 89mm)
        const middlePocketRadius = 0.0525; // 52.5mm (połowa otworu 105mm)

        // Kieszenie DOKŁADNIE na rogach i krawędziach stołu
        const halfWidth = TABLE_WIDTH / 2;
        const halfLength = TABLE_LENGTH / 2;

        // Środkowe kieszenie są głębiej w bandzie - przesunięcie na zewnątrz
        const middlePocketOutset = 0.04; // 4cm na zewnątrz od krawędzi
        // Narożne kieszenie - mniejszy outset
        const cornerPocketOutset = 0.01; // 1cm na zewnątrz od rogu

        this.pockets = [
            // Corner pockets (4) - lekko na zewnątrz od rogów
            { x: TABLE_CENTER_X - halfWidth - cornerPocketOutset, z: TABLE_CENTER_Z - halfLength - cornerPocketOutset, radius: cornerPocketRadius },
            { x: TABLE_CENTER_X - halfWidth - cornerPocketOutset, z: TABLE_CENTER_Z + halfLength + cornerPocketOutset, radius: cornerPocketRadius },
            { x: TABLE_CENTER_X + halfWidth + cornerPocketOutset, z: TABLE_CENTER_Z - halfLength - cornerPocketOutset, radius: cornerPocketRadius },
            { x: TABLE_CENTER_X + halfWidth + cornerPocketOutset, z: TABLE_CENTER_Z + halfLength + cornerPocketOutset, radius: cornerPocketRadius },
            // Middle pockets (2) - przesunięte NA ZEWNĄTRZ (głębiej w bandzie)
            { x: TABLE_CENTER_X - halfWidth - middlePocketOutset, z: TABLE_CENTER_Z, radius: middlePocketRadius },
            { x: TABLE_CENTER_X + halfWidth + middlePocketOutset, z: TABLE_CENTER_Z, radius: middlePocketRadius },
        ];

        // DEBUG: Visualize pockets
        this.createPocketDebugCircles();

        // Pozycje koszyków na bile (pod stołem, przy każdej kieszeni)
        const basketY = TABLE_SURFACE_Y - 0.12;

        this.pocketBaskets = [
            // Corner baskets
            { x: TABLE_CENTER_X - halfWidth - cornerPocketOutset, y: basketY, z: TABLE_CENTER_Z - halfLength - cornerPocketOutset },
            { x: TABLE_CENTER_X - halfWidth - cornerPocketOutset, y: basketY, z: TABLE_CENTER_Z + halfLength + cornerPocketOutset },
            { x: TABLE_CENTER_X + halfWidth + cornerPocketOutset, y: basketY, z: TABLE_CENTER_Z - halfLength - cornerPocketOutset },
            { x: TABLE_CENTER_X + halfWidth + cornerPocketOutset, y: basketY, z: TABLE_CENTER_Z + halfLength + cornerPocketOutset },
            // Middle baskets - też przesunięte na zewnątrz
            { x: TABLE_CENTER_X - halfWidth - middlePocketOutset, y: basketY, z: TABLE_CENTER_Z },
            { x: TABLE_CENTER_X + halfWidth + middlePocketOutset, y: basketY, z: TABLE_CENTER_Z },
        ];
    }

    createPocketDebugCircles() {
        const y = TABLE_SURFACE_Y + 0.015;
        const segments = 32;

        for (const pocket of this.pockets) {
            const geometry = new THREE.CircleGeometry(pocket.radius, segments);
            const material = new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                transparent: true,
                opacity: 0.5,
                side: THREE.DoubleSide
            });
            const circle = new THREE.Mesh(geometry, material);
            circle.position.set(pocket.x, y, pocket.z);
            circle.rotation.x = -Math.PI / 2;
            this.scene.add(circle);
        }
    }

    setupTableModel(tableModel, clothMaterial) {
        tableModel.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                // Replace Baize material with our procedural cloth
                const matName = child.material?.name || '';
                if (matName === 'Baize') {
                    child.material = clothMaterial;
                }
            }
        });
        this.scene.add(tableModel);
        this.tableModel = tableModel;
    }

    createCushionDebugLines() {
        // Create visible lines showing where cushions should be
        // Linie pokazują gdzie bila odbija się od bandy
        const y = TABLE_SURFACE_Y + 0.01;
        const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });

        // Minimalny offset - linie na samej krawędzi sukna
        const cushionOffset = 0.0; // Bez offsetu - dokładnie na krawędzi
        const minX = TABLE_CENTER_X - TABLE_WIDTH / 2 + cushionOffset;
        const maxX = TABLE_CENTER_X + TABLE_WIDTH / 2 - cushionOffset;
        const minZ = TABLE_CENTER_Z - TABLE_LENGTH / 2 + cushionOffset;
        const maxZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 - cushionOffset;

        // Przerwy przy kieszeniach
        const cornerGap = 0.08; // Przerwa w rogu
        const middleGap = 0.10; // Przerwa przy środkowej kieszeni
        const centerZ = TABLE_CENTER_Z;

        // Zamiast prostokąta - 4 oddzielne bandy z przerwami
        // Górna banda (minZ) - od lewego rogu do prawego rogu, z przerwami w rogach
        const topPoints = [
            new THREE.Vector3(minX + cornerGap, y, minZ),
            new THREE.Vector3(maxX - cornerGap, y, minZ),
        ];

        // Dolna banda (maxZ)
        const bottomPoints = [
            new THREE.Vector3(minX + cornerGap, y, maxZ),
            new THREE.Vector3(maxX - cornerGap, y, maxZ),
        ];

        // Lewa banda (minX) - z przerwą na środkową kieszeń
        const leftPoints1 = [
            new THREE.Vector3(minX, y, minZ + cornerGap),
            new THREE.Vector3(minX, y, centerZ - middleGap / 2),
        ];
        const leftPoints2 = [
            new THREE.Vector3(minX, y, centerZ + middleGap / 2),
            new THREE.Vector3(minX, y, maxZ - cornerGap),
        ];

        // Prawa banda (maxX) - z przerwą na środkową kieszeń
        const rightPoints1 = [
            new THREE.Vector3(maxX, y, minZ + cornerGap),
            new THREE.Vector3(maxX, y, centerZ - middleGap / 2),
        ];
        const rightPoints2 = [
            new THREE.Vector3(maxX, y, centerZ + middleGap / 2),
            new THREE.Vector3(maxX, y, maxZ - cornerGap),
        ];

        // Dodaj wszystkie linie
        const allSegments = [topPoints, bottomPoints, leftPoints1, leftPoints2, rightPoints1, rightPoints2];
        for (const points of allSegments) {
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geometry, material);
            this.scene.add(line);
        }

        console.log('DEBUG - Table boundaries (with cushion offset):');
        console.log('  X:', minX, 'to', maxX);
        console.log('  Z:', minZ, 'to', maxZ);
    }

    createBalls() {
        // Playing area dimensions - note: model has table rotated, so we swap X/Z
        const playHalfLength = TABLE_LENGTH / 2;

        const baulkLineZ = playHalfLength - 0.737; // Baulk line position (was X, now Z)
        const dRadius = 0.292; // D semicircle radius

        // Create cue ball in the D area (offset from brown)
        this.createSnookerBall('CUE', 0.1, baulkLineZ - 0.1, true);

        // Color ball spots
        const blueSpotZ = 0; // Center of table
        const pinkSpotZ = -playHalfLength / 2; // Halfway between center and black end
        const blackSpotZ = -playHalfLength + 0.324; // 324mm from cushion

        // Create 15 red balls in triangle formation behind pink spot
        // Slightly larger spacing to prevent initial overlap issues
        const spacing = BALL_RADIUS * 2.08;
        const triangleStartZ = pinkSpotZ - BALL_RADIUS * 3;
        let redIndex = 0;

        for (let row = 0; row < 5; row++) {
            for (let col = 0; col <= row; col++) {
                const z = triangleStartZ - row * spacing * 0.866;
                const x = (col - row / 2) * spacing;
                this.createSnookerBall('RED', x, z, false, redIndex++);
            }
        }

        // Create color balls on their spots
        // Baulk line colors (on the D)
        this.createSnookerBall('YELLOW', dRadius, baulkLineZ, false);
        this.createSnookerBall('GREEN', -dRadius, baulkLineZ, false);
        this.createSnookerBall('BROWN', 0, baulkLineZ, false);

        // Center line colors
        this.createSnookerBall('BLUE', 0, blueSpotZ, false);
        this.createSnookerBall('PINK', 0, pinkSpotZ, false);
        this.createSnookerBall('BLACK', 0, blackSpotZ, false);
    }

    createSnookerBall(type, x, z, isCueBall, redIndex = -1) {
        const ballData = SNOOKER_BALLS[type];
        const geometry = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);

        const material = new THREE.MeshStandardMaterial({
            color: ballData.color,
            roughness: 0.15,
            metalness: 0.05,
        });

        // Apply table center offset to ball positions
        const ballX = x + TABLE_CENTER_X;
        const ballZ = z + TABLE_CENTER_Z;
        const ballY = TABLE_SURFACE_Y + BALL_RADIUS + 0.008; // Slightly higher to ensure balls sit on cloth
        const ball = new THREE.Mesh(geometry, material);
        ball.position.set(ballX, ballY, ballZ);
        ball.castShadow = true;
        ball.receiveShadow = true;
        ball.userData = {
            type: type,
            value: ballData.value,
            name: ballData.name,
            isCueBall: isCueBall,
            isRed: type === 'RED',
            isColor: !isCueBall && type !== 'RED',
            redIndex: redIndex,
            originalPosition: { x: ballX, z: ballZ } // For re-spotting colors
        };
        this.scene.add(ball);

        // Physics body - realistic snooker ball with CCD for fast movements
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(ballX, ballY, ballZ)
            .setLinearDamping(0.0) // No artificial damping - use our own friction
            .setAngularDamping(0.0) // No artificial angular damping
            .setCcdEnabled(true); // Continuous collision detection for fast balls
        const body = this.world.createRigidBody(bodyDesc);

        // Collider with realistic snooker ball properties
        // We handle collision response ourselves, so set low restitution to avoid double-bounce
        const colliderDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
            .setRestitution(0.0) // Zero - we handle restitution in handleBallCollisions
            .setFriction(0.0) // ZERO friction - we handle rolling resistance ourselves
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
            .setMass(BALL_MASS)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        this.world.createCollider(colliderDesc, body);

        if (isCueBall) {
            this.cueBall = ball;
            this.cueBallBody = body;
        }

        // Store color ball references for re-spotting
        if (ball.userData.isColor) {
            this.colorBallsData[type] = { ball, body, originalPosition: { x, z } };
        }

        this.balls.push(ball);
        this.ballBodies.push(body);
    }

    createCueStick() {
        // Create cue stick group
        this.cueStick = new THREE.Group();
        this.cueStick.visible = false;
        this.scene.add(this.cueStick);

        // Cue stick - tip points towards +Z direction (front of group)
        const stickLength = 1.4;
        const stickGeometry = new THREE.CylinderGeometry(0.006, 0.012, stickLength, 16);
        const stickMaterial = new THREE.MeshStandardMaterial({
            color: 0x8b4513,
            roughness: 0.4,
        });

        const stickMesh = new THREE.Mesh(stickGeometry, stickMaterial);
        stickMesh.rotation.x = Math.PI / 2;
        stickMesh.position.z = stickLength / 2; // Body extends in +Z, butt at z=0
        this.cueStick.add(stickMesh);

        // Ferrule (white/ivory ring between shaft and tip)
        const ferruleGeometry = new THREE.CylinderGeometry(0.0058, 0.006, 0.025, 16);
        const ferruleMaterial = new THREE.MeshStandardMaterial({
            color: 0xf5f5dc, // Ivory/cream color
            roughness: 0.3,
            metalness: 0.1
        });
        const ferrule = new THREE.Mesh(ferruleGeometry, ferruleMaterial);
        ferrule.rotation.x = Math.PI / 2;
        ferrule.position.z = stickLength + 0.0125;
        this.cueStick.add(ferrule);

        // Leather tip base (darker leather)
        const tipBaseGeometry = new THREE.CylinderGeometry(0.0052, 0.0055, 0.008, 16);
        const tipBaseMaterial = new THREE.MeshStandardMaterial({
            color: 0x4a3728, // Dark brown leather
            roughness: 0.8,
            metalness: 0.0
        });
        const tipBase = new THREE.Mesh(tipBaseGeometry, tipBaseMaterial);
        tipBase.rotation.x = Math.PI / 2;
        tipBase.position.z = stickLength + 0.029;
        this.cueStick.add(tipBase);

        // Chalked tip - realistic blue chalk texture
        const tipGeometry = new THREE.SphereGeometry(0.005, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);

        // Create chalk texture with dust particles
        const chalkCanvas = document.createElement('canvas');
        chalkCanvas.width = 64;
        chalkCanvas.height = 64;
        const chalkCtx = chalkCanvas.getContext('2d');

        // Base blue chalk color
        chalkCtx.fillStyle = '#3d7ab5';
        chalkCtx.fillRect(0, 0, 64, 64);

        // Add chalk dust texture - random light blue spots
        for (let i = 0; i < 150; i++) {
            const x = Math.random() * 64;
            const y = Math.random() * 64;
            const size = Math.random() * 3 + 1;
            const brightness = Math.floor(Math.random() * 60 + 180);
            chalkCtx.fillStyle = `rgb(${brightness - 80}, ${brightness - 40}, ${brightness})`;
            chalkCtx.beginPath();
            chalkCtx.arc(x, y, size, 0, Math.PI * 2);
            chalkCtx.fill();
        }

        // Add some darker spots for depth
        for (let i = 0; i < 30; i++) {
            const x = Math.random() * 64;
            const y = Math.random() * 64;
            const size = Math.random() * 2 + 0.5;
            chalkCtx.fillStyle = 'rgba(30, 60, 100, 0.5)';
            chalkCtx.beginPath();
            chalkCtx.arc(x, y, size, 0, Math.PI * 2);
            chalkCtx.fill();
        }

        const chalkTexture = new THREE.CanvasTexture(chalkCanvas);
        chalkTexture.wrapS = THREE.RepeatWrapping;
        chalkTexture.wrapT = THREE.RepeatWrapping;

        const tipMaterial = new THREE.MeshStandardMaterial({
            map: chalkTexture,
            color: 0x4a90c2, // Blue chalk tint
            roughness: 0.95, // Very rough/powdery
            metalness: 0.0,
            bumpScale: 0.02
        });

        const cueTip = new THREE.Mesh(tipGeometry, tipMaterial);
        cueTip.rotation.x = -Math.PI / 2; // Dome faces forward
        cueTip.position.z = stickLength + 0.033;
        this.cueStick.add(cueTip);
        this.cueTipMesh = cueTip;

        // Add chalk dust particle system around tip
        this.createChalkDustParticles();
    }

    createChalkDustParticles() {
        // Create small particles around cue tip to simulate chalk dust
        const particleCount = 20;
        const particleGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const sizes = new Float32Array(particleCount);

        for (let i = 0; i < particleCount; i++) {
            // Random positions in a small sphere around tip
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.random() * Math.PI;
            const r = Math.random() * 0.015 + 0.005;

            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi) + 1.433; // Offset to tip position

            sizes[i] = Math.random() * 0.002 + 0.001;
        }

        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        const particleMaterial = new THREE.PointsMaterial({
            color: 0x6ab0e8,
            size: 0.003,
            transparent: true,
            opacity: 0.4,
            sizeAttenuation: true
        });

        this.chalkDustParticles = new THREE.Points(particleGeometry, particleMaterial);
        this.cueStick.add(this.chalkDustParticles);
    }

    createAimLine() {
        // Main aim line (from cue ball in shot direction)
        const material = new THREE.LineDashedMaterial({
            color: 0xffffff,
            dashSize: 0.05,
            gapSize: 0.02,
            opacity: 0.5,
            transparent: true,
        });

        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(6);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        this.aimLine = new THREE.Line(geometry, material);
        this.aimLine.visible = false;
        this.scene.add(this.aimLine);

        // Reflection line (shows where cue ball will go after hitting another ball)
        const reflectionMaterial = new THREE.LineDashedMaterial({
            color: 0xffff00,
            dashSize: 0.03,
            gapSize: 0.02,
            opacity: 0.6,
            transparent: true,
        });

        const reflectionGeometry = new THREE.BufferGeometry();
        const reflectionPositions = new Float32Array(6);
        reflectionGeometry.setAttribute('position', new THREE.BufferAttribute(reflectionPositions, 3));

        this.reflectionLine = new THREE.Line(reflectionGeometry, reflectionMaterial);
        this.reflectionLine.visible = false;
        this.scene.add(this.reflectionLine);

        // Target ball direction line (shows where hit ball will go)
        const targetMaterial = new THREE.LineDashedMaterial({
            color: 0x00ffff,
            dashSize: 0.03,
            gapSize: 0.02,
            opacity: 0.6,
            transparent: true,
        });

        const targetGeometry = new THREE.BufferGeometry();
        const targetPositions = new Float32Array(6);
        targetGeometry.setAttribute('position', new THREE.BufferAttribute(targetPositions, 3));

        this.targetLine = new THREE.Line(targetGeometry, targetMaterial);
        this.targetLine.visible = false;
        this.scene.add(this.targetLine);
    }

    setupInputHandlers() {
        const canvas = this.renderer.domElement;

        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Disable auto-center when user interacts with camera (scroll/right-click drag)
        canvas.addEventListener('wheel', () => { this.hasCameraTarget = false; });

        // Power charging with right mouse button
        this.isPowerCharging = false;
        this.powerChargeStart = 0;

        // Camera movement with WSAD
        this.cameraKeys = { w: false, a: false, s: false, d: false };

        // Keyboard controls
        window.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();

            // WSAD camera movement
            if (key === 'w') this.cameraKeys.w = true;
            if (key === 'a') this.cameraKeys.a = true;
            if (key === 's') this.cameraKeys.s = true;
            if (key === 'd') this.cameraKeys.d = true;

            if (e.key === 'r' || e.key === 'R') {
                this.resetGame();
            }
            // Shoot with spacebar when aiming
            if (e.key === ' ' && this.isAiming && this.shotPower > 0.3) {
                this.isAiming = false;
                this.cueStick.visible = false;
                this.aimLine.visible = false;
                this.reflectionLine.visible = false;
                this.targetLine.visible = false;
                this.shoot();
                this.shotPower = 0;
                document.getElementById('power-bar').style.width = '0%';
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (key === 'w') this.cameraKeys.w = false;
            if (key === 'a') this.cameraKeys.a = false;
            if (key === 's') this.cameraKeys.s = false;
            if (key === 'd') this.cameraKeys.d = false;
        });

        window.addEventListener('resize', () => this.onResize());

        // Setup spin control
        this.setupSpinControl();
    }

    setupSpinControl() {
        const spinBall = document.getElementById('spin-ball');
        const spinMarker = document.getElementById('spin-marker');
        const spinInfo = document.getElementById('spin-info');
        const spinReset = document.getElementById('spin-reset');

        if (!spinBall) return;

        let isDragging = false;

        const updateSpin = (e) => {
            const rect = spinBall.getBoundingClientRect();
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            // Get position relative to center
            let x, y;
            if (e.touches) {
                x = e.touches[0].clientX - rect.left - centerX;
                y = e.touches[0].clientY - rect.top - centerY;
            } else {
                x = e.clientX - rect.left - centerX;
                y = e.clientY - rect.top - centerY;
            }

            // Clamp to circle
            const maxRadius = centerX - 8;
            const dist = Math.sqrt(x * x + y * y);
            if (dist > maxRadius) {
                x = (x / dist) * maxRadius;
                y = (y / dist) * maxRadius;
            }

            // Convert to -1 to 1 range
            this.spinX = x / maxRadius;
            this.spinY = -y / maxRadius; // Invert Y so up = topspin

            // Update marker position
            spinMarker.style.left = `${centerX + x}px`;
            spinMarker.style.top = `${centerY + y}px`;

            // Update info text
            this.updateSpinInfo();
        };

        spinBall.addEventListener('mousedown', (e) => {
            isDragging = true;
            updateSpin(e);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                updateSpin(e);
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // Touch support
        spinBall.addEventListener('touchstart', (e) => {
            isDragging = true;
            updateSpin(e);
            e.preventDefault();
        });

        document.addEventListener('touchmove', (e) => {
            if (isDragging) {
                updateSpin(e);
            }
        });

        document.addEventListener('touchend', () => {
            isDragging = false;
        });

        // Reset button
        spinReset.addEventListener('click', () => {
            this.spinX = 0;
            this.spinY = 0;
            spinMarker.style.left = '50%';
            spinMarker.style.top = '50%';
            this.updateSpinInfo();
        });
    }

    updateSpinInfo() {
        const spinInfo = document.getElementById('spin-info');
        if (!spinInfo) return;

        const absX = Math.abs(this.spinX);
        const absY = Math.abs(this.spinY);

        if (absX < 0.1 && absY < 0.1) {
            spinInfo.textContent = 'Center (no spin)';
        } else {
            let parts = [];

            if (absY >= 0.1) {
                if (this.spinY > 0) {
                    parts.push(`Top ${Math.round(absY * 100)}%`);
                } else {
                    parts.push(`Back ${Math.round(absY * 100)}%`);
                }
            }

            if (absX >= 0.1) {
                if (this.spinX > 0) {
                    parts.push(`Right ${Math.round(absX * 100)}%`);
                } else {
                    parts.push(`Left ${Math.round(absX * 100)}%`);
                }
            }

            spinInfo.textContent = parts.join(' + ');
        }
    }

    resetGame() {
        // Simply reload the page for clean reset
        window.location.reload();
    }

    onMouseDown(event) {
        // Left click - start aiming towards clicked ball
        if (event.button === 0 && this.canShoot) {
            if (!this.cueBall || !this.cueBallBody) return;

            // Try to detect clicked ball first
            const clickedBall = this.getClickedBall(event);
            const cueBallPos = this.cueBall.position;

            let targetPos;
            if (clickedBall && !clickedBall.userData.isCueBall) {
                // Clicked on a ball - aim at its center
                targetPos = clickedBall.position;
            } else {
                // No ball clicked - get position on table
                const tablePos = this.getMousePositionOnTable(event);
                if (!tablePos) return;
                targetPos = tablePos;
            }

            this.isAiming = true;
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            this.shotPower = 0;

            // Calculate initial aim angle directly towards target
            const dx = targetPos.x - cueBallPos.x;
            const dz = targetPos.z - cueBallPos.z;
            this.aimAngle = Math.atan2(dx, dz);
            this.targetAimAngle = this.aimAngle;

            this.cueStick.visible = true;
            this.aimLine.visible = true;
            this.reflectionLine.visible = false;
            this.targetLine.visible = false;

            // Position and rotate cue stick
            this.updateCueStickTransform(cueBallPos, this.aimAngle, 0);

            // Update aim line immediately
            this.updateAimLine(cueBallPos, this.aimAngle);

            // Kamera pozostaje statyczna - nie wyłączamy orbit controls
            // (lewy przycisk myszy i tak nie rusza kamery w naszej konfiguracji)
        }

        // Right click - start charging power (only when aiming), or orbit camera
        if (event.button === 2) {
            if (this.isAiming) {
                this.isPowerCharging = true;
                this.powerChargeStart = Date.now();
            } else {
                // User is orbiting camera - disable auto-center
                this.hasCameraTarget = false;
            }
        }
    }

    updateCueStickTransform(cueBallPos, angle, power) {
        // Tip is at local +Z (at stickLength), group origin is at butt
        const stickLength = 1.4;
        const baseGap = 0.04; // Gap between tip and ball when power=0
        const powerPullback = (power / this.maxPower) * 0.45;

        // Total distance from group origin to ball = stickLength + gap + pullback
        const totalDistance = stickLength + baseGap + powerPullback;

        // Position group so tip ends up near ball
        // Cue behind ball, opposite to shot direction
        const cueX = cueBallPos.x - Math.sin(angle) * totalDistance;
        const cueZ = cueBallPos.z - Math.cos(angle) * totalDistance;

        this.cueStick.position.set(cueX, cueBallPos.y, cueZ);

        // Rotate so +Z (tip direction) points at ball
        this.cueStick.rotation.y = angle;
    }

    onMouseMove(event) {
        if (!this.isAiming) return;
        if (!this.cueBall) return;

        // Calculate mouse delta for relative aiming
        const deltaX = event.clientX - this.lastMouseX;
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;

        // Adjust target angle based on horizontal mouse movement
        // Much lower sensitivity when charging power (right mouse held)
        const baseSensitivity = 0.003;
        const sensitivity = this.isPowerCharging ? baseSensitivity / 30 : baseSensitivity;
        this.targetAimAngle += deltaX * sensitivity;

        // Smooth interpolation towards target angle
        const smoothing = 0.15; // Lower = smoother but slower
        let angleDiff = this.targetAimAngle - this.aimAngle;

        // Handle angle wrapping
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        this.aimAngle += angleDiff * smoothing;

        // Update power bar
        const powerPercent = (this.shotPower / this.maxPower) * 100;
        document.getElementById('power-bar').style.width = `${powerPercent}%`;
        document.getElementById('power-percent').textContent = `${Math.round(powerPercent)}%`;

        // Update cue stick position and rotation
        const cueBallPos = this.cueBall.position;
        this.updateCueStickTransform(cueBallPos, this.aimAngle, this.shotPower);

        // Update aim line (shows shot direction)
        this.updateAimLine(cueBallPos, this.aimAngle);
    }

    getClickedBall(event) {
        // Raycast to detect if user clicked on a ball
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        // Check intersection with all balls
        const intersects = raycaster.intersectObjects(this.balls);
        if (intersects.length > 0) {
            return intersects[0].object;
        }
        return null;
    }

    setFirstPersonAimCamera(cueBallPos, aimAngle) {
        // Set camera to first-person view from behind cue ball
        // Looking down the aiming line towards the target

        const cameraDistance = 0.6; // Distance behind cue ball
        const cameraHeight = 0.25; // Height above ball for better view

        // Camera positioned behind cue ball, opposite to shot direction
        const camX = cueBallPos.x - Math.sin(aimAngle) * cameraDistance;
        const camZ = cueBallPos.z - Math.cos(aimAngle) * cameraDistance;
        const camY = cueBallPos.y + cameraHeight;

        // Store current camera position for smooth return
        this.savedCameraPosition = this.camera.position.clone();
        this.savedControlsTarget = this.controls.target.clone();

        // Store target position for smooth transition (don't set immediately)
        this.aimCameraTarget = new THREE.Vector3(camX, camY, camZ);

        // Look at point ahead of cue ball in shot direction
        const lookAtDistance = 1.5;
        const lookAtX = cueBallPos.x + Math.sin(aimAngle) * lookAtDistance;
        const lookAtZ = cueBallPos.z + Math.cos(aimAngle) * lookAtDistance;
        const lookAtY = cueBallPos.y;

        this.aimLookAtTarget = new THREE.Vector3(lookAtX, lookAtY, lookAtZ);

        // Enable smooth transition
        this.isTransitioningToAim = true;
    }

    updateFirstPersonCamera() {
        // Update camera position during aiming to follow aim angle changes
        if (!this.isAiming || !this.cueBall) return;

        const cueBallPos = this.cueBall.position;
        const cameraDistance = 0.6;
        const cameraHeight = 0.25;

        // Calculate target camera position based on current aim angle
        const targetCamX = cueBallPos.x - Math.sin(this.aimAngle) * cameraDistance;
        const targetCamZ = cueBallPos.z - Math.cos(this.aimAngle) * cameraDistance;
        const targetCamY = cueBallPos.y + cameraHeight;

        // Update aim camera target
        if (this.aimCameraTarget) {
            this.aimCameraTarget.set(targetCamX, targetCamY, targetCamZ);
        }

        // Calculate look-at point
        const lookAtDistance = 1.5;
        const lookAtX = cueBallPos.x + Math.sin(this.aimAngle) * lookAtDistance;
        const lookAtZ = cueBallPos.z + Math.cos(this.aimAngle) * lookAtDistance;
        const lookAtY = cueBallPos.y;

        if (this.aimLookAtTarget) {
            this.aimLookAtTarget.set(lookAtX, lookAtY, lookAtZ);
        }

        // Smooth interpolation - faster when transitioning, slower when adjusting aim
        const smoothing = this.isTransitioningToAim ? 0.08 : 0.12;

        // Smoothly move camera position
        this.camera.position.x += (targetCamX - this.camera.position.x) * smoothing;
        this.camera.position.y += (targetCamY - this.camera.position.y) * smoothing;
        this.camera.position.z += (targetCamZ - this.camera.position.z) * smoothing;

        // Smoothly move look-at target
        this.controls.target.x += (lookAtX - this.controls.target.x) * smoothing;
        this.controls.target.y += (lookAtY - this.controls.target.y) * smoothing;
        this.controls.target.z += (lookAtZ - this.controls.target.z) * smoothing;

        // Check if transition is complete
        if (this.isTransitioningToAim) {
            const distToTarget = Math.sqrt(
                Math.pow(this.camera.position.x - targetCamX, 2) +
                Math.pow(this.camera.position.y - targetCamY, 2) +
                Math.pow(this.camera.position.z - targetCamZ, 2)
            );
            if (distToTarget < 0.01) {
                this.isTransitioningToAim = false;
            }
        }
    }

    restoreCameraPosition() {
        // Smoothly restore camera to position before aiming
        if (this.savedCameraPosition && this.savedControlsTarget) {
            // Animate back to saved position
            this.cameraTargetPosition.copy(this.savedCameraPosition);
            this.cameraLookAtTarget.copy(this.savedControlsTarget);
            this.hasCameraTarget = true;
        }
    }

    getMousePositionOnTable(event) {
        // Convert mouse position to 3D position on table surface
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        // Create a plane at table surface height
        const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_SURFACE_Y);
        const intersection = new THREE.Vector3();

        if (raycaster.ray.intersectPlane(tablePlane, intersection)) {
            return intersection;
        }
        return null;
    }

    updateAimLine(cueBallPos, angle) {
        const shotDirX = Math.sin(angle);
        const shotDirZ = Math.cos(angle);

        // Długość linii celowania zależy od siły strzału
        // Minimum 0.5m, maksimum 3m przy pełnej mocy
        const powerFactor = Math.max(0.1, this.shotPower / this.maxPower);
        const baseAimLength = 0.5 + powerFactor * 2.5;

        // Precyzyjne wykrywanie kolizji - używamy dokładnego promienia
        const hitResult = this.findBallInPathPrecise(cueBallPos, shotDirX, shotDirZ, baseAimLength);

        const positions = this.aimLine.geometry.attributes.position.array;

        // Line starts at cue ball
        positions[0] = cueBallPos.x;
        positions[1] = cueBallPos.y;
        positions[2] = cueBallPos.z;

        if (hitResult && hitResult.distance < baseAimLength) {
            // Line ends at the hit point (where cue ball center will be at contact)
            positions[3] = hitResult.contactPoint.x;
            positions[4] = cueBallPos.y;
            positions[5] = hitResult.contactPoint.z;

            // Show reflection line (cue ball direction after hit) with physics-based calculation
            this.updateReflectionLinePhysics(hitResult, shotDirX, shotDirZ, powerFactor);
        } else {
            // No ball hit within range - check for cushion collision and extend line
            const cushionHit = this.findCushionInPath(cueBallPos, shotDirX, shotDirZ, baseAimLength);
            if (cushionHit) {
                positions[3] = cushionHit.point.x;
                positions[4] = cueBallPos.y;
                positions[5] = cushionHit.point.z;
            } else {
                // Extend to power-dependent length
                positions[3] = cueBallPos.x + shotDirX * baseAimLength;
                positions[4] = cueBallPos.y;
                positions[5] = cueBallPos.z + shotDirZ * baseAimLength;
            }

            // Hide reflection lines
            this.reflectionLine.visible = false;
            this.targetLine.visible = false;
        }

        // Aktualizuj opacity linii w zależności od mocy (jaśniejsza przy większej mocy)
        const opacity = 0.3 + powerFactor * 0.5;
        this.aimLine.material.opacity = opacity;

        this.aimLine.geometry.attributes.position.needsUpdate = true;
        this.aimLine.computeLineDistances();
    }

    findBallInPathPrecise(cueBallPos, dirX, dirZ, maxDistance = 3.0) {
        let closestHit = null;
        let minDist = Infinity;
        const R = BALL_RADIUS;
        const collisionDist = R * 2; // Dokładna odległość przy kolizji

        for (const ball of this.balls) {
            if (ball.userData.isCueBall) continue;
            if (ball.userData.isPocketed || ball.userData.isBeingRemoved) continue;

            // Vector from cue ball to target ball center
            const dx = ball.position.x - cueBallPos.x;
            const dz = ball.position.z - cueBallPos.z;

            // Project onto shot direction
            const projection = dx * dirX + dz * dirZ;

            // Ball is behind us or too far
            if (projection <= 0 || projection > maxDistance + collisionDist) continue;

            // Perpendicular distance squared (unikamy sqrt dla wydajności)
            const perpX = dx - dirX * projection;
            const perpZ = dz - dirZ * projection;
            const perpDistSq = perpX * perpX + perpZ * perpZ;

            // Check if line passes close enough to hit
            if (perpDistSq < collisionDist * collisionDist) {
                // Dokładne obliczenie punktu kontaktu używając geometrii
                // Bila biała dotknie bilę obiektową gdy odległość środków = 2R
                const perpDist = Math.sqrt(perpDistSq);
                const offset = Math.sqrt(collisionDist * collisionDist - perpDistSq);
                const contactDist = projection - offset;

                if (contactDist > R * 0.1 && contactDist < minDist) {
                    minDist = contactDist;

                    // Punkt gdzie środek bili białej będzie w momencie kontaktu
                    const contactX = cueBallPos.x + dirX * contactDist;
                    const contactZ = cueBallPos.z + dirZ * contactDist;

                    // Normalna kolizji (od bili białej do obiektowej)
                    const collisionNormalX = (ball.position.x - contactX) / collisionDist;
                    const collisionNormalZ = (ball.position.z - contactZ) / collisionDist;

                    // Kąt cięcia (cut angle)
                    const cutAngle = Math.acos(Math.abs(dirX * collisionNormalX + dirZ * collisionNormalZ)) * 180 / Math.PI;

                    closestHit = {
                        ball: ball,
                        distance: contactDist,
                        contactPoint: { x: contactX, z: contactZ },
                        targetBallPos: { x: ball.position.x, z: ball.position.z },
                        collisionNormal: { x: collisionNormalX, z: collisionNormalZ },
                        cutAngle: cutAngle,
                        perpDist: perpDist
                    };
                }
            }
        }

        return closestHit;
    }

    findCushionInPath(startPos, dirX, dirZ, maxDist) {
        const cushionOffset = BALL_RADIUS + 0.002;
        const minX = TABLE_CENTER_X - TABLE_WIDTH / 2 + cushionOffset;
        const maxX = TABLE_CENTER_X + TABLE_WIDTH / 2 - cushionOffset;
        const minZ = TABLE_CENTER_Z - TABLE_LENGTH / 2 + cushionOffset;
        const maxZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 + cushionOffset;

        let closest = null;
        let minT = maxDist;

        // Left cushion
        if (dirX < -0.001) {
            const t = (minX - startPos.x) / dirX;
            if (t > 0 && t < minT) {
                const z = startPos.z + dirZ * t;
                if (z >= minZ && z <= maxZ) {
                    minT = t;
                    closest = { point: { x: minX, z: z }, cushion: 'left', normal: { x: 1, z: 0 } };
                }
            }
        }
        // Right cushion
        if (dirX > 0.001) {
            const t = (maxX - startPos.x) / dirX;
            if (t > 0 && t < minT) {
                const z = startPos.z + dirZ * t;
                if (z >= minZ && z <= maxZ) {
                    minT = t;
                    closest = { point: { x: maxX, z: z }, cushion: 'right', normal: { x: -1, z: 0 } };
                }
            }
        }
        // Top cushion (negative Z)
        if (dirZ < -0.001) {
            const t = (minZ - startPos.z) / dirZ;
            if (t > 0 && t < minT) {
                const x = startPos.x + dirX * t;
                if (x >= minX && x <= maxX) {
                    minT = t;
                    closest = { point: { x: x, z: minZ }, cushion: 'top', normal: { x: 0, z: 1 } };
                }
            }
        }
        // Bottom cushion (positive Z)
        if (dirZ > 0.001) {
            const t = (maxZ - startPos.z) / dirZ;
            if (t > 0 && t < minT) {
                const x = startPos.x + dirX * t;
                if (x >= minX && x <= maxX) {
                    minT = t;
                    closest = { point: { x: x, z: maxZ }, cushion: 'bottom', normal: { x: 0, z: -1 } };
                }
            }
        }

        return closest;
    }

    updateReflectionLinePhysics(hitResult, shotDirX, shotDirZ, powerFactor = 0.5) {
        // Używamy prawdziwej fizyki kolizji elastycznej
        // Dla równych mas: bila biała oddaje składową normalną, zachowuje styczną
        // Bila obiektowa otrzymuje składową normalną

        const nx = hitResult.collisionNormal.x;
        const nz = hitResult.collisionNormal.z;

        // Składowa normalna prędkości bili białej (do przekazania bili obiektowej)
        const dotProduct = shotDirX * nx + shotDirZ * nz;

        // Prędkość bili białej po kolizji (odejmujemy składową normalną)
        // Dla idealnej kolizji sprężystej z równymi masami
        const cueBallReflectX = shotDirX - dotProduct * nx;
        const cueBallReflectZ = shotDirZ - dotProduct * nz;
        const cueBallReflectLen = Math.sqrt(cueBallReflectX * cueBallReflectX + cueBallReflectZ * cueBallReflectZ);

        // Prędkość bili obiektowej po kolizji (otrzymuje składową normalną)
        const targetBallDirX = dotProduct * nx;
        const targetBallDirZ = dotProduct * nz;
        const targetBallLen = Math.sqrt(targetBallDirX * targetBallDirX + targetBallDirZ * targetBallDirZ);

        // Długość linii predykcji zależna od siły (dłuższe przy większej sile)
        // Teraz używamy przekazanego powerFactor
        const reflectionLength = 0.3 + powerFactor * 1.2;

        // Update cue ball reflection line (yellow)
        const reflPos = this.reflectionLine.geometry.attributes.position.array;
        reflPos[0] = hitResult.contactPoint.x;
        reflPos[1] = this.cueBall.position.y;
        reflPos[2] = hitResult.contactPoint.z;

        if (cueBallReflectLen > 0.01) {
            // Bila biała poleci w kierunku odbicia
            const normCueX = cueBallReflectX / cueBallReflectLen;
            const normCueZ = cueBallReflectZ / cueBallReflectLen;

            // Sprawdź czy bila biała trafi w bandę lub inną bilę
            const cueBallPath = this.findCushionInPath(hitResult.contactPoint, normCueX, normCueZ, reflectionLength);
            const endDist = cueBallPath ? Math.min(cueBallPath.point.x !== undefined ?
                Math.sqrt(Math.pow(cueBallPath.point.x - hitResult.contactPoint.x, 2) + Math.pow(cueBallPath.point.z - hitResult.contactPoint.z, 2)) : reflectionLength, reflectionLength) : reflectionLength;

            reflPos[3] = hitResult.contactPoint.x + normCueX * endDist * cueBallReflectLen;
            reflPos[4] = this.cueBall.position.y;
            reflPos[5] = hitResult.contactPoint.z + normCueZ * endDist * cueBallReflectLen;
            this.reflectionLine.visible = true;
            
            // Opacity zależna od mocy
            this.reflectionLine.material.opacity = 0.3 + powerFactor * 0.4;
        } else {
            // Direct hit - cue ball stops (lub prawie)
            reflPos[3] = hitResult.contactPoint.x;
            reflPos[4] = this.cueBall.position.y;
            reflPos[5] = hitResult.contactPoint.z;
            this.reflectionLine.visible = false;
        }

        this.reflectionLine.geometry.attributes.position.needsUpdate = true;
        this.reflectionLine.computeLineDistances();

        // Update target ball direction line (cyan)
        const targetPos = this.targetLine.geometry.attributes.position.array;
        targetPos[0] = hitResult.targetBallPos.x;
        targetPos[1] = this.cueBall.position.y;
        targetPos[2] = hitResult.targetBallPos.z;

        if (targetBallLen > 0.01) {
            const normTargetX = targetBallDirX / targetBallLen;
            const normTargetZ = targetBallDirZ / targetBallLen;

            // Długość zależy od siły i transferu energii
            const targetEndDist = reflectionLength * targetBallLen * 1.5;

            targetPos[3] = hitResult.targetBallPos.x + normTargetX * targetEndDist;
            targetPos[4] = this.cueBall.position.y;
            targetPos[5] = hitResult.targetBallPos.z + normTargetZ * targetEndDist;
        } else {
            targetPos[3] = hitResult.targetBallPos.x;
            targetPos[4] = this.cueBall.position.y;
            targetPos[5] = hitResult.targetBallPos.z;
        }

        // Opacity zależna od mocy
        this.targetLine.material.opacity = 0.3 + powerFactor * 0.5;

        this.targetLine.geometry.attributes.position.needsUpdate = true;
        this.targetLine.computeLineDistances();
        this.targetLine.visible = true;
    }

    onMouseUp(event) {
        // Right click release - shoot if power > 0
        if (event.button === 2 && this.isAiming) {
            this.isPowerCharging = false;

            if (this.shotPower > 0.3 && this.cueBallBody) {
                this.isAiming = false;
                this.cueStick.visible = false;
                this.aimLine.visible = false;
                this.reflectionLine.visible = false;
                this.targetLine.visible = false;
                this.shoot();
                this.shotPower = 0;
                document.getElementById('power-bar').style.width = '0%';
                document.getElementById('power-percent').textContent = '0%';
            }
            return;
        }

        // Left click release - cancel aiming (don't shoot)
        if (event.button === 0 && this.isAiming) {
            this.isAiming = false;
            this.isPowerCharging = false;
            this.cueStick.visible = false;
            this.aimLine.visible = false;
            this.reflectionLine.visible = false;
            this.targetLine.visible = false;
            this.shotPower = 0;
            document.getElementById('power-bar').style.width = '0%';
            document.getElementById('power-percent').textContent = '0%';
        }
    }

    shoot() {
        if (!this.cueBallBody) return;

        // Wake up the body first
        this.cueBallBody.wakeUp();

        // Realistic snooker cue impulse
        const normalizedPower = this.shotPower / this.maxPower; // 0-1
        const maxImpulse = 0.35; // Strong max power for break shots
        const power = normalizedPower * normalizedPower * maxImpulse;

        // Shot direction vector
        const shotDirX = Math.sin(this.aimAngle);
        const shotDirZ = Math.cos(this.aimAngle);

        // Calculate initial velocity from impulse: v = J/m
        const initialSpeed = power / BALL_MASS;
        const initialVelX = shotDirX * initialSpeed;
        const initialVelZ = shotDirZ * initialSpeed;

        // Reset any existing velocity and spin first
        this.cueBallBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.cueBallBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

        // ===== USE PHYSICS MODULE FOR SPIN APPLICATION =====
        // Initialize BallState for cue ball
        const cueBallState = new BallState();
        cueBallState.position = {
            x: this.cueBall.position.x,
            y: this.cueBall.position.y,
            z: this.cueBall.position.z
        };

        // Apply shot using physics module - this calculates spin correctly
        applyShot(cueBallState, normalizedPower, this.aimAngle, this.spinX, this.spinY, 8);

        // KLUCZOWE: Używamy prędkości z physics module (która uwzględnia spin)
        // ale skalujemy do naszego power
        const speedRatio = initialSpeed / (cueBallState.speed > 0.01 ? cueBallState.speed : 1);

        // Ustaw prędkość liniową bezpośrednio (nie przez impulse, żeby mieć kontrolę)
        this.cueBallBody.setLinvel({ x: initialVelX, y: 0, z: initialVelZ }, true);

        // Ustaw prędkość kątową z physics module (poprawnie obliczona dla spinu)
        const angularVel = {
            x: cueBallState.angularVelocity.x,
            y: cueBallState.angularVelocity.y,
            z: cueBallState.angularVelocity.z
        };
        this.cueBallBody.setAngvel(angularVel, true);

        // KLUCZOWE: Zsynchronizuj cueBallState z rzeczywistą prędkością
        cueBallState.velocity = { x: initialVelX, y: 0, z: initialVelZ };

        // Store ball state for physics tracking - to będzie "source of truth"
        const cueBallIndex = this.balls.findIndex(b => b.userData.isCueBall);
        if (cueBallIndex >= 0) {
            this.ballStates[cueBallIndex] = cueBallState;
        } else {
            this.ballStates[0] = cueBallState; // Fallback
        }

        this.shots++;
        this.canShoot = false;

        // Track shot stats
        this.lastShotPower = this.shotPower;
        this.lastMaxSpeed = this.currentMaxSpeed;
        this.currentMaxSpeed = 0;

        // === ENHANCED PHYSICS LOGGING ===
        this.currentShotId++;
        const shotId = this.currentShotId;
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const timestamp = Date.now();

        // Calculate cue tip contact point on ball (based on spin settings)
        // spinX: -1 = left edge, 0 = center, 1 = right edge
        // spinY: -1 = bottom, 0 = center, 1 = top
        const tipContactX = this.spinX * BALL_RADIUS * 0.7; // Max 70% offset from center
        const tipContactY = this.spinY * BALL_RADIUS * 0.7;
        const tipContactZ = -Math.sqrt(BALL_RADIUS * BALL_RADIUS - tipContactX * tipContactX - tipContactY * tipContactY);

        // Use physics module constants for prediction
        const rollingResistance = PHYSICS_CONFIG.world.table_friction_roll;
        const slidingFriction = PHYSICS_CONFIG.world.table_friction_slide;
        const g = PHYSICS_CONFIG.world.gravity;
        const dt = 1 / 120;

        // Predict roll distance using proper slide/roll physics
        let simSpeed = initialSpeed;
        let simDistance = 0;
        let simAngVel = cueBallState.angularSpeed;
        let phase = 'sliding'; // Start in sliding phase after cue strike

        let steps = 0;
        while (simSpeed > PHYSICS_CONFIG.thresholds.velocity_stop && steps < 10000) {
            simDistance += simSpeed * dt;

            // Calculate slip velocity
            const surfaceSpeed = simAngVel * BALL_RADIUS;
            const slipSpeed = Math.abs(simSpeed - surfaceSpeed);

            if (slipSpeed > PHYSICS_CONFIG.thresholds.slip_threshold) {
                // Sliding phase - higher friction
                const friction = slidingFriction * g;
                simSpeed = Math.max(0, simSpeed - friction * dt);
                // Angular velocity approaches natural roll
                const targetAngVel = simSpeed / BALL_RADIUS;
                simAngVel += (targetAngVel - simAngVel) * 0.1;
                phase = 'sliding';
            } else {
                // Rolling phase - lower friction
                const friction = rollingResistance * g;
                simSpeed = Math.max(0, simSpeed - friction * dt);
                simAngVel = simSpeed / BALL_RADIUS;
                phase = 'rolling';
            }

            steps++;
        }

        const predictedDistance = simDistance;

        // Get ball state diagnostics
        const ballDiagnostics = getBallDiagnostics(cueBallState);

        // Calculate spin type description
        let spinDescription = 'Center (no spin)';
        const absX = Math.abs(this.spinX);
        const absY = Math.abs(this.spinY);
        if (absX >= 0.1 || absY >= 0.1) {
            const parts = [];
            if (absY >= 0.1) parts.push(this.spinY > 0 ? `Topspin ${(absY * 100).toFixed(0)}%` : `Backspin ${(absY * 100).toFixed(0)}%`);
            if (absX >= 0.1) parts.push(this.spinX > 0 ? `Right English ${(absX * 100).toFixed(0)}%` : `Left English ${(absX * 100).toFixed(0)}%`);
            spinDescription = parts.join(' + ');
        }

        // Store shot start position and all ball positions
        const cueBallPos = this.cueBall.position.clone();
        const allBallPositions = {};
        for (let i = 0; i < this.balls.length; i++) {
            const ball = this.balls[i];
            if (ball) {
                const name = ball.userData.isCueBall ? 'CueBall' : ball.userData.name + (ball.userData.redIndex >= 0 ? `_${ball.userData.redIndex}` : '');
                allBallPositions[name] = {
                    x: ball.position.x - TABLE_CENTER_X,
                    z: ball.position.z - TABLE_CENTER_Z
                };
            }
        }

        // Create comprehensive shot data
        const shotData = {
            shotId,
            timestamp,
            time,

            // Cue ball state before shot
            cueBall: {
                position: {
                    x: cueBallPos.x - TABLE_CENTER_X,
                    z: cueBallPos.z - TABLE_CENTER_Z,
                    tableRelative: true
                },
                absolutePosition: {
                    x: cueBallPos.x,
                    y: cueBallPos.y,
                    z: cueBallPos.z
                }
            },

            // Shot parameters
            shot: {
                powerPercent: normalizedPower * 100,
                powerRaw: this.shotPower,
                maxPower: this.maxPower,
                impulse: power,
                impulseVector: { x: impulse.x, y: impulse.y, z: impulse.z },
                aimAngle: this.aimAngle,
                aimAngleDegrees: (this.aimAngle * 180 / Math.PI),
                direction: { x: shotDirX, z: shotDirZ }
            },

            // Spin/English parameters
            spin: {
                spinX: this.spinX,
                spinY: this.spinY,
                description: spinDescription,
                tipContact: {
                    x: tipContactX,
                    y: tipContactY,
                    z: tipContactZ,
                    offsetFromCenter: Math.sqrt(tipContactX * tipContactX + tipContactY * tipContactY)
                }
            },

            // Initial physics state (from physics module)
            physics: {
                initialSpeed,
                initialSpeedKmh: initialSpeed * 3.6,
                initialAngularVelocity: {
                    x: cueBallState.angularVelocity.x,
                    y: cueBallState.angularVelocity.y,
                    z: cueBallState.angularVelocity.z
                },
                naturalAngularVelocity: {
                    x: -initialVelZ / BALL_RADIUS,
                    y: 0,
                    z: initialVelX / BALL_RADIUS
                },
                spinFactor: Math.abs(this.spinY) > 0.1 ? (1 + this.spinY * 1.5) : 1,
                sideSpinRate: cueBallState.angularVelocity.y,
                predictedRollDistance: predictedDistance,
                kineticEnergy: 0.5 * BALL_MASS * initialSpeed * initialSpeed,
                momentum: BALL_MASS * initialSpeed,
                // Physics config used
                physicsConfig: {
                    frictionSlide: PHYSICS_CONFIG.world.table_friction_slide,
                    frictionRoll: PHYSICS_CONFIG.world.table_friction_roll,
                    napFactor: PHYSICS_CONFIG.world.nap_drift_factor,
                    restitutionBall: PHYSICS_CONFIG.ball.restitution_ball_ball,
                    restitutionCushion: PHYSICS_CONFIG.ball.restitution_ball_cushion
                }
            },

            // Table state
            tableState: {
                allBallPositions,
                redsRemaining: this.redsRemaining,
                currentPlayer: this.currentPlayer,
                player1Score: this.player1Score,
                player2Score: this.player2Score
            },

            // Events during this shot (will be populated)
            events: [],
            trajectory: []
        };

        // Store for event collection
        this.currentShotData = shotData;
        this.shotStartTimestamp = timestamp;
        this.isTrackingShot = true;
        this.shotTrajectories = {};

        // Initialize trajectory tracking for all balls
        for (let i = 0; i < this.balls.length; i++) {
            const ball = this.balls[i];
            if (ball) {
                const name = ball.userData.isCueBall ? 'CueBall' : ball.userData.name + (ball.userData.redIndex >= 0 ? `_${ball.userData.redIndex}` : '');
                this.shotTrajectories[name] = [];
            }
        }

        // Add to physics log
        this.physicsLog.unshift(shotData);
        if (this.physicsLog.length > 20) this.physicsLog.pop();

        // Log to collision log for UI
        const powerPct = Math.round(normalizedPower * 100);
        let spinText = '';
        if (Math.abs(this.spinX) > 0.1 || Math.abs(this.spinY) > 0.1) {
            const spinParts = [];
            if (Math.abs(this.spinY) > 0.1) spinParts.push(this.spinY > 0 ? 'top' : 'back');
            if (Math.abs(this.spinX) > 0.1) spinParts.push(this.spinX > 0 ? 'right' : 'left');
            spinText = ` [${spinParts.join('+')}]`;
        }

        this.collisionLog.unshift({
            text: `${time.split(':').slice(1).join(':')} 🎯 Shot #${shotId} ${powerPct}%${spinText} → ${initialSpeed.toFixed(2)}m/s`,
            type: 'shot',
            data: shotData
        });
        if (this.collisionLog.length > 50) this.collisionLog.pop();
        this.updateCollisionLog();

        // Reset camera target so it will be set again when balls stop
        this.hasCameraTarget = false;

        // Visual feedback
        this.createShotEffect();
    }

    createShotEffect() {
        // Shot effect disabled - was creating distracting white flash
    }

    checkPockets() {
        // Skip during reset
        if (this.resetting) return;

        // Table bounds for sanity check
        const tableMinX = TABLE_CENTER_X - TABLE_WIDTH / 2 - 0.1;
        const tableMaxX = TABLE_CENTER_X + TABLE_WIDTH / 2 + 0.1;
        const tableMinZ = TABLE_CENTER_Z - TABLE_LENGTH / 2 - 0.1;
        const tableMaxZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 + 0.1;

        for (let i = this.balls.length - 1; i >= 0; i--) {
            const ball = this.balls[i];

            // Skip if ball is undefined or just created (y position check)
            if (!ball) continue;
            if (ball.userData.isPocketed) continue; // Already pocketed, waiting for respot
            if (ball.userData.isBeingRemoved) continue; // Being removed
            if (ball.position.y > TABLE_SURFACE_Y + BALL_RADIUS * 2) continue; // Ball still settling
            if (ball.position.y < TABLE_SURFACE_Y - 0.1) continue; // Ball fell through - ignore

            // Skip balls that are way off table (teleported during respawn)
            if (ball.position.x < tableMinX - 1 || ball.position.x > tableMaxX + 1 ||
                ball.position.z < tableMinZ - 1 || ball.position.z > tableMaxZ + 1) continue;

            for (let pocketIndex = 0; pocketIndex < this.pockets.length; pocketIndex++) {
                const pocket = this.pockets[pocketIndex];
                const dx = ball.position.x - pocket.x;
                const dz = ball.position.z - pocket.z;
                const dist = Math.sqrt(dx * dx + dz * dz);

                // Bila wpada gdy jej środek jest w obrębie promienia kieszeni + promień bili
                // To symuluje że bila "wchodzi" do kieszeni gdy jej krawędź przekroczy brzeg
                if (dist < pocket.radius + BALL_RADIUS * 0.5) {
                    this.pocketBall(i, pocketIndex);
                    break;
                }
            }
        }
    }

    pocketBall(index, pocketIndex = 0) {
        const ball = this.balls[index];
        const body = this.ballBodies[index];

        if (!ball || !body) return;

        // Prevent double-pocketing
        if (ball.userData.isPocketed) return;
        ball.userData.isPocketed = true;
        ball.userData.isBeingRemoved = true;

        // Get basket position for this pocket
        const basket = this.pocketBaskets ? this.pocketBaskets[pocketIndex] : null;

        const ballName = ball.userData.isCueBall ? 'Cue' : ball.userData.name;

        if (ball.userData.isCueBall) {
            // Cue ball pocketed - animate fall then respawn
            this.logPocket('Cue Ball', 0);

            // Usuń ciało fizyczne
            try {
                this.world.removeRigidBody(body);
            } catch (e) { }

            // Animate falling into basket
            this.animateBallToPocket(ball, basket, () => {
                // After animation, respawn
                ball.visible = false;
                setTimeout(() => {
                    // Utwórz nowe ciało fizyczne dla bili białej
                    this.respotCueBall();
                    ball.userData.isPocketed = false;
                    ball.userData.isBeingRemoved = false;
                    ball.scale.setScalar(1); // Reset skali po animacji
                    ball.visible = true;
                }, 300);
            });

        } else if (ball.userData.isRed) {
            // Red ball potted
            this.logPocket('Red', 1);
            this.addPoints(1);
            this.redsRemaining--;

            // Usuń ciało fizyczne NATYCHMIAST
            try {
                this.world.removeRigidBody(body);
            } catch (e) { }

            // Remove red ball permanently with animation
            this.removeBallPermanently(index, ball, body, basket);

        } else if (ball.userData.isColor) {
            // Color ball potted
            const colorValue = ball.userData.value;
            const colorName = ball.userData.name;

            this.logPocket(colorName, colorValue);
            this.addPoints(colorValue);

            if (this.redsRemaining > 0) {
                // Still reds on table - NIE usuwaj ciała, tylko przenieś daleko
                // Będzie respotowane później
                body.setTranslation({ x: 100, y: -10, z: 100 }, true);
                body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                body.setAngvel({ x: 0, y: 0, z: 0 }, true);

                this.animateBallToPocket(ball, basket, () => {
                    ball.visible = false;
                    ball.scale.setScalar(1); // Reset skali
                    this.pendingRespots.push({ type: ball.userData.type, index, ball, body });
                });
            } else {
                // No reds left - remove permanently
                try {
                    this.world.removeRigidBody(body);
                } catch (e) { }
                this.removeBallPermanently(index, ball, body, basket);
            }
        }
    }

    animateBallToPocket(ball, basket, onComplete) {
        if (!basket) {
            // No basket info - just complete immediately
            if (onComplete) onComplete();
            return;
        }

        const startPos = { x: ball.position.x, y: ball.position.y, z: ball.position.z };
        const endPos = { x: basket.x, y: basket.y, z: basket.z };
        const duration = 500; // 500ms animation - dłużej dla płynności
        const startTime = Date.now();

        // Środek łuku - bila najpierw lekko opada, potem przyspiesza
        const midY = startPos.y - 0.03; // Lekkie zagłębienie na początku

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Easing function - ease-in dla realistycznego opadania (przyspiesza)
            const eased = progress * progress; // Kwadratowe ease-in

            // Interpolate XZ position liniowo
            ball.position.x = startPos.x + (endPos.x - startPos.x) * eased;
            ball.position.z = startPos.z + (endPos.z - startPos.z) * eased;

            // Y - krzywa paraboliczna (najpierw wolno, potem szybko)
            // Używamy krzywej kwadratowej która przyspiesza spadanie
            ball.position.y = startPos.y + (endPos.y - startPos.y) * eased;

            // Add slight rotation during fall - bila się kręci gdy wpada
            ball.rotation.x += 0.08 * (1 + progress);
            ball.rotation.z += 0.04 * (1 + progress);

            // Lekkie zmniejszanie podczas wpadania
            const scale = 1 - progress * 0.15;
            ball.scale.setScalar(scale);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                if (onComplete) onComplete();
            }
        };
        animate();
    }

    handleFoul(points, message) {
        // Award foul points to opponent
        const foulPoints = Math.max(4, points);
        if (this.currentPlayer === 1) {
            this.player2Score += foulPoints;
        } else {
            this.player1Score += foulPoints;
        }
        this.showMessage(`FOUL! ${message} +${foulPoints} to opponent`);
        this.updateScoreDisplay();
        this.switchPlayer();
    }

    addPoints(points) {
        if (this.currentPlayer === 1) {
            this.player1Score += points;
        } else {
            this.player2Score += points;
        }
        this.updateScoreDisplay();
    }

    switchPlayer() {
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
        this.mustPotColor = false;
        document.getElementById('game-status').textContent = `Player ${this.currentPlayer}'s turn`;
    }

    updateScoreDisplay() {
        // Score is now updated in updateHUD
    }

    respotCueBall() {
        const ball = this.cueBall;

        if (!ball) {
            console.error('respotCueBall: cueBall is null');
            return;
        }

        if (!this.world) {
            console.error('respotCueBall: world is null');
            return;
        }

        // Reset to D area (baulk end) - baulk line is at positive Z end
        // Table is rotated: X is width, Z is length
        const playHalfLength = TABLE_LENGTH / 2;
        const baulkLineZ = playHalfLength - 0.737; // Baulk line position from table center
        const dRadius = 0.292; // D semicircle radius

        // Default position: on baulk line, to the right of yellow (positive X)
        let resetX = TABLE_CENTER_X + dRadius * 0.5; // Right side of D
        let resetZ = TABLE_CENTER_Z + baulkLineZ;

        // Find safe position within the D
        for (let attempt = 0; attempt < 20; attempt++) {
            let overlap = false;
            for (const otherBall of this.balls) {
                if (otherBall === ball) continue;
                if (!otherBall || !otherBall.position) continue;
                const dx = otherBall.position.x - resetX;
                const dz = otherBall.position.z - resetZ;
                if (Math.sqrt(dx * dx + dz * dz) < BALL_RADIUS * 3) {
                    overlap = true;
                    // Try different positions along the baulk line
                    resetX -= BALL_RADIUS * 2;
                    if (resetX < TABLE_CENTER_X - dRadius) {
                        resetX = TABLE_CENTER_X + dRadius * 0.5;
                        resetZ -= BALL_RADIUS * 2;
                    }
                    break;
                }
            }
            if (!overlap) break;
        }

        const resetPos = { x: resetX, y: TABLE_SURFACE_Y + BALL_RADIUS + 0.005, z: resetZ };

        try {
            // Utwórz nowe ciało fizyczne dla bili białej
            const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(resetPos.x, resetPos.y, resetPos.z)
                .setLinearDamping(0.0)
                .setAngularDamping(0.0)
                .setCcdEnabled(true);
            const newBody = this.world.createRigidBody(bodyDesc);

            const colliderDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
                .setRestitution(0.0)
                .setFriction(0.0)
                .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
                .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
                .setMass(BALL_MASS)
                .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
            this.world.createCollider(colliderDesc, newBody);

            // Zaktualizuj referencje
            const cueBallIndex = this.balls.findIndex(b => b && b.userData && b.userData.isCueBall);
            if (cueBallIndex >= 0) {
                this.ballBodies[cueBallIndex] = newBody;
            }
            this.cueBallBody = newBody;

            ball.position.set(resetPos.x, resetPos.y, resetPos.z);
            ball.rotation.set(0, 0, 0);

            // Reset ball state for cue ball
            if (cueBallIndex >= 0 && this.ballStates && this.ballStates[cueBallIndex]) {
                this.ballStates[cueBallIndex].velocity = { x: 0, y: 0, z: 0 };
                this.ballStates[cueBallIndex].angularVelocity = { x: 0, y: 0, z: 0 };
                this.ballStates[cueBallIndex].position = { x: resetX, y: resetPos.y, z: resetZ };
                this.ballStates[cueBallIndex].phase = 'stationary';
            }

            // Pozwól na strzelanie
            this.canShoot = true;
        } catch (e) {
            console.error('respotCueBall error:', e);
        }
    }

    respotColorBall(type, index, ball, body) {
        const originalPos = ball.userData.originalPosition;
        let spotX = originalPos.x;
        let spotZ = originalPos.z;

        // Check if original spot is occupied
        let spotOccupied = false;
        for (const otherBall of this.balls) {
            if (otherBall === ball) continue;
            const dx = otherBall.position.x - spotX;
            const dz = otherBall.position.z - spotZ;
            if (Math.sqrt(dx * dx + dz * dz) < BALL_RADIUS * 2.5) {
                spotOccupied = true;
                break;
            }
        }

        if (spotOccupied) {
            // Find nearest available spot (higher value color spots)
            const spotOrder = ['BLACK', 'PINK', 'BLUE', 'BROWN', 'GREEN', 'YELLOW'];
            for (const spotType of spotOrder) {
                if (this.colorBallsData[spotType]) {
                    const altPos = this.colorBallsData[spotType].originalPosition;
                    let altOccupied = false;
                    for (const otherBall of this.balls) {
                        if (otherBall === ball) continue;
                        const dx = otherBall.position.x - altPos.x;
                        const dz = otherBall.position.z - altPos.z;
                        if (Math.sqrt(dx * dx + dz * dz) < BALL_RADIUS * 2.5) {
                            altOccupied = true;
                            break;
                        }
                    }
                    if (!altOccupied) {
                        spotX = altPos.x;
                        spotZ = altPos.z;
                        break;
                    }
                }
            }
        }

        const resetPos = { x: spotX, y: TABLE_SURFACE_Y + BALL_RADIUS + 0.005, z: spotZ };
        body.setTranslation(resetPos, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        ball.position.set(resetPos.x, resetPos.y, resetPos.z);
        ball.visible = true;
        ball.userData.isPocketed = false; // Clear pocketed flag

        // Reset ball state
        if (this.ballStates[index]) {
            this.ballStates[index].velocity = { x: 0, y: 0, z: 0 };
            this.ballStates[index].angularVelocity = { x: 0, y: 0, z: 0 };
            this.ballStates[index].phase = 'stationary';
        }
    }

    removeBallPermanently(index, ball, body, basket = null) {
        // Mark ball as being removed to prevent sync issues
        ball.userData.isBeingRemoved = true;
        ball.userData.isPocketed = true;

        // Ciało fizyczne już zostało usunięte w pocketBall()
        // Nie próbuj usuwać ponownie

        // Animate ball falling into basket
        if (basket) {
            this.animateBallToPocket(ball, basket, () => {
                // After reaching basket, shrink and remove
                const shrinkDuration = 200;
                const shrinkStart = Date.now();

                const shrinkAnim = () => {
                    const elapsed = Date.now() - shrinkStart;
                    const progress = Math.min(elapsed / shrinkDuration, 1);
                    ball.scale.setScalar(1 - progress);

                    if (progress < 1) {
                        requestAnimationFrame(shrinkAnim);
                    } else {
                        this.scene.remove(ball);
                    }
                };
                shrinkAnim();
            });
        } else {
            // Fallback - simple fall animation
            const startY = ball.position.y;
            const fallDuration = 300;
            const startTime = Date.now();

            const animateFall = () => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / fallDuration, 1);

                ball.position.y = startY - progress * 0.2;
                ball.scale.setScalar(1 - progress * 0.5);

                if (progress < 1) {
                    requestAnimationFrame(animateFall);
                } else {
                    this.scene.remove(ball);
                }
            };
            animateFall();
        }

        // NATYCHMIAST usuń z tablic - NIE po animacji!
        this.balls.splice(index, 1);
        this.ballBodies.splice(index, 1);

        // Update references
        const cueBallIndex = this.balls.findIndex(b => b.userData.isCueBall);
        if (cueBallIndex >= 0) {
            this.cueBall = this.balls[cueBallIndex];
            this.cueBallBody = this.ballBodies[cueBallIndex];
        }

        this.pocketedBalls.push(ball.userData.type);
        this.updatePocketedBallsDisplay();
    }

    checkGameEnd() {
        // Count remaining balls (excluding cue ball)
        const remainingBalls = this.balls.filter(b => !b.userData.isCueBall);

        if (remainingBalls.length === 0) {
            const winner = this.player1Score > this.player2Score ? 1 :
                this.player2Score > this.player1Score ? 2 : 0;
            if (winner === 0) {
                this.showMessage('🎱 Game Over - Draw!');
            } else {
                this.showMessage(`🎱 Player ${winner} Wins! Final: ${this.player1Score}-${this.player2Score}`);
            }
        }
    }

    updatePocketedBallsDisplay() {
        const container = document.getElementById('pocketed-balls');
        container.innerHTML = '';

        this.pocketedBalls.forEach(type => {
            const ballData = SNOOKER_BALLS[type];
            if (ballData) {
                const div = document.createElement('div');
                div.className = 'pocketed-ball';
                div.style.backgroundColor = '#' + ballData.color.toString(16).padStart(6, '0');
                div.title = `${ballData.name} (${ballData.value} pts)`;
                container.appendChild(div);
            }
        });
    }

    showMessage(text) {
        const msg = document.getElementById('message');
        msg.textContent = text;
        msg.style.display = 'block';

        setTimeout(() => {
            msg.style.display = 'none';
        }, 2000);
    }

    checkBallsMoving() {
        let moving = false;

        // Sprawdź czy jest bila w trakcie animacji wpadania
        for (const ball of this.balls) {
            if (ball && ball.userData && (ball.userData.isPocketed || ball.userData.isBeingRemoved)) {
                // Bila w trakcie animacji - traktuj jako ruch
                moving = true;
                break;
            }
        }

        if (!moving) {
            for (const body of this.ballBodies) {
                if (!body) continue;

                try {
                    const vel = body.linvel();
                    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);

                    if (speed > 0.01) {
                        moving = true;
                        break;
                    }
                } catch (e) {
                    // Body może być usunięte - ignoruj
                }
            }
        }

        if (!moving && !this.canShoot) {
            // Process pending color ball respots now that all balls have stopped
            this.processPendingRespots();

            this.canShoot = true;
            const target = this.mustPotColor ? 'a Color' : 'a Red';
            document.getElementById('game-status').textContent = `Player ${this.currentPlayer} - Pot ${target}!`;
            document.getElementById('reds-remaining').textContent = this.redsRemaining;

            // Center camera on suggested target when balls stop
            if (this.wasMoving) {
                this.centerCameraOnTarget();
            }
        } else if (moving) {
            document.getElementById('game-status').textContent = 'Balls in motion...';
        }

        this.wasMoving = moving;
        return moving;
    }

    processPendingRespots() {
        // Respot all color balls that were pocketed during the shot
        while (this.pendingRespots.length > 0) {
            const { type, index, ball, body } = this.pendingRespots.shift();
            this.respotColorBall(type, index, ball, body);
            // Note: respotColorBall now handles visibility and isPocketed flag
        }
    }

    updateHUD() {
        if (!this.cueBallBody) return;

        try {
            const vel = this.cueBallBody.linvel();
            const angVel = this.cueBallBody.angvel();
            const pos = this.cueBallBody.translation();

            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
            const angSpeed = Math.sqrt(angVel.x * angVel.x + angVel.y * angVel.y + angVel.z * angVel.z);
            const energy = 0.5 * BALL_MASS * speed * speed;
            const momentum = BALL_MASS * speed;

            // Track max speed during shot
            if (speed > this.currentMaxSpeed) {
                this.currentMaxSpeed = speed;
            }

            // Update velocity with color coding
            const velEl = document.getElementById('ball-velocity');
            velEl.textContent = speed.toFixed(3) + ' m/s';
            velEl.className = 'physics-value' + (speed > 1.0 ? ' highlight' : speed > 0.5 ? ' warning' : '');

            document.getElementById('ball-angular').textContent = angSpeed.toFixed(2) + ' rad/s';
            document.getElementById('ball-pos-x').textContent = (pos.x - TABLE_CENTER_X).toFixed(3);
            document.getElementById('ball-pos-z').textContent = (pos.z - TABLE_CENTER_Z).toFixed(3);
            document.getElementById('ball-energy').textContent = energy.toFixed(4) + ' J';
            document.getElementById('ball-momentum').textContent = momentum.toFixed(4);

            // Last shot stats
            document.getElementById('last-power').textContent = this.lastShotPower > 0 ?
                Math.round(this.lastShotPower / this.maxPower * 100) + '%' : '-';
            document.getElementById('last-max-speed').textContent = this.lastMaxSpeed > 0 ?
                this.lastMaxSpeed.toFixed(2) + ' m/s' : '-';

            // Calculate spin relative to velocity direction
            // Natural roll: angVel perpendicular to velocity
            const naturalAngX = speed > 0.01 ? -vel.z / BALL_RADIUS : 0;
            const naturalAngZ = speed > 0.01 ? vel.x / BALL_RADIUS : 0;
            const spinDiffX = angVel.x - naturalAngX;
            const spinDiffZ = angVel.z - naturalAngZ;
            const spinDiffMag = Math.sqrt(spinDiffX * spinDiffX + spinDiffZ * spinDiffZ);

            // Spin type with magnitude
            let spinType = 'None';
            if (angSpeed > 0.5) {
                const spinParts = [];
                // Check for topspin/backspin (rotation perpendicular to movement)
                if (speed > 0.01 && spinDiffMag > 1) {
                    // Dot product of spin diff with velocity direction
                    const velDirX = vel.x / speed;
                    const velDirZ = vel.z / speed;
                    // Backspin reduces forward momentum
                    const backspinAmount = -(spinDiffX * (-velDirZ) + spinDiffZ * velDirX);
                    if (Math.abs(backspinAmount) > 1) {
                        spinParts.push(backspinAmount > 0 ? `Back ${Math.abs(backspinAmount).toFixed(0)}` : `Top ${Math.abs(backspinAmount).toFixed(0)}`);
                    }
                }
                // Side spin
                if (Math.abs(angVel.y) > 0.5) {
                    spinParts.push(angVel.y > 0 ? `Side← ${Math.abs(angVel.y).toFixed(0)}` : `Side→ ${Math.abs(angVel.y).toFixed(0)}`);
                }
                spinType = spinParts.length > 0 ? spinParts.join(' ') : `Roll ${angSpeed.toFixed(0)}`;
            }
            document.getElementById('ball-spin').textContent = spinType;

            // Update score display
            const p1El = document.getElementById('p1-score');
            const p2El = document.getElementById('p2-score');
            p1El.textContent = this.player1Score;
            p2El.textContent = this.player2Score;
            p1El.className = 'score-value' + (this.currentPlayer === 1 ? ' player-active' : '');
            p2El.className = 'score-value' + (this.currentPlayer === 2 ? ' player-active' : '');

            // Update target indicator
            this.updateTargetIndicator();

        } catch (e) { }
    }

    updateTargetIndicator() {
        const preview = document.getElementById('target-ball-preview');
        const text = document.getElementById('target-text');

        if (this.mustPotColor) {
            // Must pot a color - show next available
            if (this.redsRemaining > 0) {
                preview.style.background = 'linear-gradient(135deg, #ffcc00 0%, #ff6699 50%, #0066cc 100%)';
                text.textContent = 'Pot any Color';
            } else {
                // Colors in order
                const colorOrder = ['YELLOW', 'GREEN', 'BROWN', 'BLUE', 'PINK', 'BLACK'];
                for (const colorName of colorOrder) {
                    const ball = this.balls.find(b => b.userData.type === colorName);
                    if (ball) {
                        preview.style.background = '#' + SNOOKER_BALLS[colorName].color.toString(16).padStart(6, '0');
                        text.textContent = `Pot ${colorName.charAt(0) + colorName.slice(1).toLowerCase()}`;
                        break;
                    }
                }
            }
        } else {
            preview.style.background = '#cc0000';
            text.textContent = 'Pot a Red';
        }
    }

    logCollision(ball1Name, ball2Name, relSpeed, velA, velB, posA, posB) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false }).split(':').slice(1).join(':');
        const timestamp = Date.now();

        // Calculate speeds
        const speedA = Math.sqrt(velA.x * velA.x + velA.z * velA.z);
        const speedB = Math.sqrt(velB.x * velB.x + velB.z * velB.z);

        // Calculate collision normal
        const dx = posB.x - posA.x;
        const dz = posB.z - posA.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const nx = dx / dist;
        const nz = dz / dist;

        // Calculate impact component (velocity along collision normal)
        const impactA = velA.x * nx + velA.z * nz;
        const impactB = velB.x * nx + velB.z * nz;

        // Calculate collision angle (angle between velocity and collision normal)
        const velAMag = speedA;
        const collisionAngleA = velAMag > 0.01 ? Math.acos(Math.abs(impactA) / velAMag) * 180 / Math.PI : 0;

        // Calculate kinetic energies
        const keBefore = 0.5 * BALL_MASS * (speedA * speedA + speedB * speedB);

        // Calculate cut angle (angle of deflection for object ball)
        const cutAngle = Math.atan2(nz, nx) * 180 / Math.PI;

        const collisionData = {
            timestamp,
            shotId: this.currentShotId,
            type: 'ball_collision',
            balls: [ball1Name, ball2Name],

            // Relative speed at impact
            relativeSpeed: relSpeed,

            // Ball A (typically cue ball)
            ballA: {
                name: ball1Name,
                speedBefore: speedA,
                velocityBefore: { x: velA.x, z: velA.z },
                position: {
                    x: posA.x - TABLE_CENTER_X,
                    z: posA.z - TABLE_CENTER_Z
                },
                impactComponent: impactA,
                collisionAngle: collisionAngleA
            },

            // Ball B (object ball)
            ballB: {
                name: ball2Name,
                speedBefore: speedB,
                velocityBefore: { x: velB.x, z: velB.z },
                position: {
                    x: posB.x - TABLE_CENTER_X,
                    z: posB.z - TABLE_CENTER_Z
                },
                impactComponent: impactB
            },

            // Collision geometry
            geometry: {
                collisionNormal: { x: nx, z: nz },
                distance: dist,
                cutAngle,
                contactPoint: {
                    x: (posA.x + posB.x) / 2 - TABLE_CENTER_X,
                    z: (posA.z + posB.z) / 2 - TABLE_CENTER_Z
                }
            },

            // Energy
            kineticEnergyBefore: keBefore
        };

        // Add to current shot events
        if (this.currentShotData && this.isTrackingShot) {
            this.currentShotData.events.push(collisionData);
        }

        const entry = `${time} ${ball1Name}↔${ball2Name} rel:${relSpeed.toFixed(2)} | ${ball1Name}:${speedA.toFixed(2)}m/s ${ball2Name}:${speedB.toFixed(2)}m/s | cut:${cutAngle.toFixed(0)}°`;

        this.collisionLog.unshift({ text: entry, type: 'collision', data: collisionData });
        if (this.collisionLog.length > 50) this.collisionLog.pop();

        this.updateCollisionLog();
    }

    logCushionHit(ballName, side, speed, velBefore, velAfter, incidenceAngle = 0, energyLossPct = 0) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false }).split(':').slice(1).join(':');
        const timestamp = Date.now();

        const speedAfter = Math.sqrt(velAfter.x * velAfter.x + velAfter.z * velAfter.z);
        const actualEnergyLoss = ((speed * speed - speedAfter * speedAfter) / (speed * speed) * 100);
        const energyLoss = energyLossPct > 0 ? energyLossPct : actualEnergyLoss;

        // Calculate reflection angle
        let cushionNormal = { x: 0, z: 0 };
        if (side.includes('Left')) cushionNormal.x = 1;
        else if (side.includes('Right')) cushionNormal.x = -1;
        if (side.includes('Top')) cushionNormal.z = 1;
        else if (side.includes('Bottom')) cushionNormal.z = -1;

        // Normalize if corner hit
        const normMag = Math.sqrt(cushionNormal.x * cushionNormal.x + cushionNormal.z * cushionNormal.z);
        if (normMag > 0) {
            cushionNormal.x /= normMag;
            cushionNormal.z /= normMag;
        }

        // Calculate actual incidence angle
        const velMagBefore = speed;
        const dotBefore = velBefore.x * cushionNormal.x + velBefore.z * cushionNormal.z;
        const actualIncidenceAngle = velMagBefore > 0.01 ? Math.acos(Math.abs(dotBefore) / velMagBefore) * 180 / Math.PI : 0;

        // Calculate reflection angle
        const dotAfter = velAfter.x * cushionNormal.x + velAfter.z * cushionNormal.z;
        const reflectionAngle = speedAfter > 0.01 ? Math.acos(Math.abs(dotAfter) / speedAfter) * 180 / Math.PI : 0;

        // Calculate direction change
        const dirBefore = { x: velBefore.x / speed, z: velBefore.z / speed };
        const dirAfter = speedAfter > 0.01 ? { x: velAfter.x / speedAfter, z: velAfter.z / speedAfter } : { x: 0, z: 0 };
        const directionChange = Math.acos(dirBefore.x * dirAfter.x + dirBefore.z * dirAfter.z) * 180 / Math.PI;

        const cushionData = {
            timestamp,
            shotId: this.currentShotId,
            type: 'cushion_hit',
            ball: ballName,
            cushion: side,

            // Speed data
            speedBefore: speed,
            speedAfter,
            speedLoss: speed - speedAfter,
            speedLossPercent: ((speed - speedAfter) / speed * 100),

            // Velocity vectors
            velocityBefore: { x: velBefore.x, z: velBefore.z },
            velocityAfter: { x: velAfter.x, z: velAfter.z },

            // Angles
            incidenceAngle: actualIncidenceAngle,
            reflectionAngle,
            directionChange,

            // Energy
            energyLossPercent: energyLoss,
            kineticEnergyBefore: 0.5 * BALL_MASS * speed * speed,
            kineticEnergyAfter: 0.5 * BALL_MASS * speedAfter * speedAfter,

            // Cushion info
            cushionNormal,

            // Coefficient of restitution
            coefficientOfRestitution: speedAfter / speed
        };

        // Add to current shot events
        if (this.currentShotData && this.isTrackingShot) {
            this.currentShotData.events.push(cushionData);
        }

        const angleStr = actualIncidenceAngle > 0 ? ` @${actualIncidenceAngle.toFixed(0)}°` : '';
        const entry = `${time} 🧱 ${ballName}→${side}${angleStr} ${speed.toFixed(2)}→${speedAfter.toFixed(2)}m/s (-${energyLoss.toFixed(0)}%) CoR:${(speedAfter / speed).toFixed(2)}`;

        this.collisionLog.unshift({ text: entry, type: 'cushion', data: cushionData });
        if (this.collisionLog.length > 50) this.collisionLog.pop();

        this.updateCollisionLog();
    }

    logPocket(ballName, points) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false }).split(':').slice(1).join(':');
        const timestamp = Date.now();

        // Find which pocket
        let pocketName = 'Unknown';
        let pocketIndex = -1;
        if (this.pockets) {
            const ball = this.balls.find(b => (b.userData.isCueBall ? 'Cue Ball' : b.userData.name) === ballName);
            if (ball) {
                let minDist = Infinity;
                for (let i = 0; i < this.pockets.length; i++) {
                    const pocket = this.pockets[i];
                    const dx = ball.position.x - pocket.x;
                    const dz = ball.position.z - pocket.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist < minDist) {
                        minDist = dist;
                        pocketIndex = i;
                    }
                }
            }
        }

        const pocketNames = ['Top-Left', 'Bottom-Left', 'Top-Right', 'Bottom-Right', 'Middle-Left', 'Middle-Right'];
        pocketName = pocketNames[pocketIndex] || 'Unknown';

        const pocketData = {
            timestamp,
            shotId: this.currentShotId,
            type: 'pocket',
            ball: ballName,
            points,
            pocket: pocketName,
            pocketIndex,
            timeSinceShotStart: this.shotStartTimestamp ? timestamp - this.shotStartTimestamp : 0
        };

        // Add to current shot events
        if (this.currentShotData && this.isTrackingShot) {
            this.currentShotData.events.push(pocketData);
        }

        const entry = `${time} ⚫ ${ballName} → ${pocketName} pocket (+${points})`;

        this.collisionLog.unshift({ text: entry, type: 'pocket', data: pocketData });
        if (this.collisionLog.length > 50) this.collisionLog.pop();

        this.updateCollisionLog();
    }

    updateCollisionLog() {
        const logEl = document.getElementById('collision-log');
        if (!logEl) return;

        logEl.innerHTML = this.collisionLog.map(entry =>
            `<div class="log-entry ${entry.type}">${entry.text}</div>`
        ).join('');
    }

    copyCollisionLog() {
        // Finalize current shot data if still tracking
        if (this.currentShotData && this.isTrackingShot) {
            this.finalizeCurrentShot();
        }

        const logData = {
            exportTimestamp: new Date().toISOString(),
            gameVersion: '1.0.0',

            // Physical constants used
            physicsConstants: {
                BALL_RADIUS,
                BALL_MASS,
                BALL_DIAMETER: BALL_RADIUS * 2,
                TABLE_LENGTH,
                TABLE_WIDTH,
                TABLE_CENTER_X,
                TABLE_CENTER_Z,
                TABLE_SURFACE_Y,
                POCKET_RADIUS,
                gravity: 9.81,
                rollingResistance: 0.006,
                ballBallRestitution: 0.96,
                ballBallFriction: 0.05,
                cushionRestitution: 0.85,
                momentOfInertia: (2 / 5) * BALL_MASS * BALL_RADIUS * BALL_RADIUS
            },

            // Real snooker reference values
            realSnookerReference: {
                ballDiameter_mm: 52.5,
                ballMass_g: 142,
                tablePlaying_mm: { length: 3569, width: 1778 },
                pocketOpenings_mm: { corner: 89, middle: 105 },
                cushionHeight_mm: 36,
                clothSpeed: 'Strachan No.10 tournament speed',
                notes: [
                    'Pro max cue ball speed: ~8-10 m/s',
                    'Break shot speed: ~4-6 m/s',
                    'Typical pot shot: ~1-3 m/s',
                    'Rolling resistance coefficient: 0.01-0.02',
                    'Ball-ball CoR: 0.92-0.98',
                    'Cushion CoR varies with angle: 0.6-0.95'
                ]
            },

            // Game state
            gameState: {
                totalShots: this.shots,
                player1Score: this.player1Score,
                player2Score: this.player2Score,
                redsRemaining: this.redsRemaining,
                ballsOnTable: this.balls.length
            },

            // Full shot history with all physics data
            shotHistory: this.physicsLog,

            // Summary statistics
            summary: this.generatePhysicsSummary(),

            // Recent events (collision log)
            recentEvents: this.collisionLog.map(e => e.data || { text: e.text, type: e.type })
        };

        const text = JSON.stringify(logData, null, 2);
        navigator.clipboard.writeText(text).then(() => {
            this.showMessage('📋 Full physics log copied!');
        }).catch(() => {
            console.log(text);
            this.showMessage('Log printed to console');
        });
    }

    finalizeCurrentShot() {
        if (!this.currentShotData) return;

        const endTime = Date.now();
        const duration = endTime - this.shotStartTimestamp;

        // Add trajectory data
        this.currentShotData.trajectory = { ...this.shotTrajectories };
        this.currentShotData.duration = duration;
        this.currentShotData.durationSeconds = duration / 1000;

        // Calculate actual roll distance for cue ball
        if (this.cueBall && this.currentShotData.cueBall) {
            const startPos = this.currentShotData.cueBall.absolutePosition;
            const endPos = this.cueBall.position;
            const actualDistance = Math.sqrt(
                Math.pow(endPos.x - startPos.x, 2) +
                Math.pow(endPos.z - startPos.z, 2)
            );
            this.currentShotData.actualRollDistance = actualDistance;
            this.currentShotData.distanceError = actualDistance - this.currentShotData.physics.predictedRollDistance;
        }

        // Count events
        this.currentShotData.eventSummary = {
            ballCollisions: this.currentShotData.events.filter(e => e.type === 'ball_collision').length,
            cushionHits: this.currentShotData.events.filter(e => e.type === 'cushion_hit').length,
            pockets: this.currentShotData.events.filter(e => e.type === 'pocket').length
        };

        this.isTrackingShot = false;
    }

    trackBallTrajectories() {
        // Track ball positions every frame during shot
        if (!this.isTrackingShot) return;

        const elapsed = Date.now() - this.shotStartTimestamp;

        // Only track every 50ms to avoid huge data
        if (elapsed % 50 > 16) return;

        for (let i = 0; i < this.balls.length; i++) {
            const ball = this.balls[i];
            const body = this.ballBodies[i];
            if (!ball || !body) continue;

            const name = ball.userData.isCueBall ? 'CueBall' : ball.userData.name + (ball.userData.redIndex >= 0 ? `_${ball.userData.redIndex}` : '');

            if (!this.shotTrajectories[name]) {
                this.shotTrajectories[name] = [];
            }

            try {
                const vel = body.linvel();
                const angVel = body.angvel();
                const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

                // Only track if ball is moving
                if (speed > 0.01 || this.shotTrajectories[name].length === 0) {
                    this.shotTrajectories[name].push({
                        t: elapsed,
                        x: ball.position.x - TABLE_CENTER_X,
                        z: ball.position.z - TABLE_CENTER_Z,
                        vx: vel.x,
                        vz: vel.z,
                        speed,
                        angY: angVel.y // Side spin
                    });
                }
            } catch (e) { }
        }
    }

    generatePhysicsSummary() {
        // Analyze logged events and generate detailed statistics
        const cushionHits = this.collisionLog.filter(e => e.type === 'cushion' && e.data);
        const ballCollisions = this.collisionLog.filter(e => e.type === 'collision' && e.data);
        const shots = this.collisionLog.filter(e => e.type === 'shot' && e.data);
        const pockets = this.collisionLog.filter(e => e.type === 'pocket' && e.data);

        const summary = {
            totalEvents: this.collisionLog.length,
            shots: shots.length,
            ballCollisions: ballCollisions.length,
            cushionHits: cushionHits.length,
            pockets: pockets.length,
            pointsScored: pockets.reduce((sum, p) => sum + (p.data?.points || 0), 0)
        };

        // Cushion statistics
        if (cushionHits.length > 0) {
            const energyLosses = cushionHits.map(e => e.data.energyLossPercent || 0);
            const angles = cushionHits.map(e => e.data.incidenceAngle || 0);
            const cors = cushionHits.map(e => e.data.coefficientOfRestitution || 0);
            const speedsBefore = cushionHits.map(e => e.data.speedBefore || 0);

            summary.cushion = {
                count: cushionHits.length,
                avgEnergyLoss: (energyLosses.reduce((a, b) => a + b, 0) / energyLosses.length).toFixed(1) + '%',
                minEnergyLoss: Math.min(...energyLosses).toFixed(1) + '%',
                maxEnergyLoss: Math.max(...energyLosses).toFixed(1) + '%',
                avgCoR: (cors.reduce((a, b) => a + b, 0) / cors.length).toFixed(3),
                minCoR: Math.min(...cors).toFixed(3),
                maxCoR: Math.max(...cors).toFixed(3),
                avgIncidenceAngle: (angles.reduce((a, b) => a + b, 0) / angles.length).toFixed(1) + '°',
                avgSpeedAtImpact: (speedsBefore.reduce((a, b) => a + b, 0) / speedsBefore.length).toFixed(3) + ' m/s',
                // Group by angle ranges
                perpendicular_0_30: cushionHits.filter(e => (e.data.incidenceAngle || 0) < 30).length,
                medium_30_60: cushionHits.filter(e => (e.data.incidenceAngle || 0) >= 30 && (e.data.incidenceAngle || 0) < 60).length,
                glancing_60_90: cushionHits.filter(e => (e.data.incidenceAngle || 0) >= 60).length,
                // Group by cushion
                byCushion: {
                    left: cushionHits.filter(e => e.data.cushion?.includes('Left')).length,
                    right: cushionHits.filter(e => e.data.cushion?.includes('Right')).length,
                    top: cushionHits.filter(e => e.data.cushion?.includes('Top')).length,
                    bottom: cushionHits.filter(e => e.data.cushion?.includes('Bottom')).length
                }
            };
        }

        // Ball collision statistics
        if (ballCollisions.length > 0) {
            const relSpeeds = ballCollisions.map(e => e.data.relativeSpeed || 0);
            const cutAngles = ballCollisions.map(e => Math.abs(e.data.geometry?.cutAngle || 0));

            summary.ballCollisions_stats = {
                count: ballCollisions.length,
                avgRelSpeed: (relSpeeds.reduce((a, b) => a + b, 0) / relSpeeds.length).toFixed(3) + ' m/s',
                maxRelSpeed: Math.max(...relSpeeds).toFixed(3) + ' m/s',
                avgCutAngle: (cutAngles.reduce((a, b) => a + b, 0) / cutAngles.length).toFixed(1) + '°',
                // Count cue ball collisions
                cueBallCollisions: ballCollisions.filter(e =>
                    e.data.ballA?.name === 'Cue' || e.data.ballB?.name === 'Cue'
                ).length
            };
        }

        // Shot statistics
        if (shots.length > 0) {
            const powers = shots.map(e => e.data.shot?.powerPercent || 0);
            const speeds = shots.map(e => e.data.physics?.initialSpeed || 0);
            const spinsX = shots.map(e => Math.abs(e.data.spin?.spinX || 0));
            const spinsY = shots.map(e => Math.abs(e.data.spin?.spinY || 0));

            summary.shots_stats = {
                count: shots.length,
                avgPower: (powers.reduce((a, b) => a + b, 0) / powers.length).toFixed(0) + '%',
                maxPower: Math.max(...powers).toFixed(0) + '%',
                avgInitialSpeed: (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(3) + ' m/s',
                maxInitialSpeed: Math.max(...speeds).toFixed(3) + ' m/s',
                shotsWithSpin: shots.filter(e =>
                    Math.abs(e.data.spin?.spinX || 0) > 0.1 || Math.abs(e.data.spin?.spinY || 0) > 0.1
                ).length,
                avgSideEnglish: (spinsX.reduce((a, b) => a + b, 0) / spinsX.length * 100).toFixed(0) + '%',
                avgTopBackSpin: (spinsY.reduce((a, b) => a + b, 0) / spinsY.length * 100).toFixed(0) + '%'
            };
        }

        // Physics accuracy metrics
        summary.physicsMetrics = {
            simulationTimestep: '1/120s (8.33ms)',
            substepsPerFrame: 4,
            collisionDetection: 'Continuous (CCD enabled)',
            frictionModel: 'Rolling resistance + spin-dependent',
            collisionModel: 'Marlow elastic with spin transfer'
        };

        return summary;
    }

    syncPhysicsToGraphics() {
        // Note: table is rotated - WIDTH along X, LENGTH along Z
        const playHalfWidth = TABLE_WIDTH / 2;
        const playHalfLength = TABLE_LENGTH / 2;

        for (let i = 0; i < this.balls.length; i++) {
            const ball = this.balls[i];
            const body = this.ballBodies[i];

            if (!ball || !body) continue;

            // Skip balls that are being removed (pocketed)
            if (ball.userData.isPocketed || ball.userData.isBeingRemoved) continue;

            const position = body.translation();
            const rotation = body.rotation();

            // Check if ball flew completely off table (using table center offset)
            if (Math.abs(position.x - TABLE_CENTER_X) > playHalfWidth + 0.5 ||
                Math.abs(position.z - TABLE_CENTER_Z) > playHalfLength + 0.5 ||
                position.y < TABLE_SURFACE_Y - 0.5 || position.y > TABLE_SURFACE_Y + 1.0) {

                if (ball.userData.isCueBall) {
                    const baulkLineZ = TABLE_CENTER_Z + playHalfLength - 0.737;
                    const resetPos = {
                        x: TABLE_CENTER_X + 0.1,
                        y: TABLE_SURFACE_Y + BALL_RADIUS + 0.005,
                        z: baulkLineZ - 0.1
                    };
                    body.setTranslation(resetPos, true);
                    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                    ball.position.set(resetPos.x, resetPos.y, resetPos.z);
                    continue;
                } else {
                    // Non-cue ball out of bounds and NOT pocketed - this is an error state
                    // Only reset color balls; red balls that escape should be removed
                    if (ball.userData.originalPosition && !ball.userData.isRed) {
                        // Color balls can be reset to spot
                        const orig = ball.userData.originalPosition;
                        const resetPos = {
                            x: orig.x,
                            y: TABLE_SURFACE_Y + BALL_RADIUS + 0.005,
                            z: orig.z
                        };
                        body.setTranslation(resetPos, true);
                        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                        ball.position.set(resetPos.x, resetPos.y, resetPos.z);
                    } else {
                        // If no original position (shouldn't happen for initial balls), just remove it
                        this.removeBallPermanently(i, ball, body);
                        i--; // Adjust index since we removed an element
                    }
                    continue;
                }
            }

            ball.position.set(position.x, position.y, position.z);
            ball.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        }
    }

    handleBallCollisions() {
        // Realistic ball collision physics with THROW EFFECT
        // Uses physics.js module for Marlow-based collision model

        const now = Date.now();
        if (!this.lastCollisions) this.lastCollisions = {};

        const R = PHYSICS_CONFIG.ball.radius;
        const minDist = R * 2;

        for (let i = 0; i < this.ballBodies.length; i++) {
            for (let j = i + 1; j < this.ballBodies.length; j++) {
                const bodyA = this.ballBodies[i];
                const bodyB = this.ballBodies[j];
                const ballA = this.balls[i];
                const ballB = this.balls[j];

                if (!bodyA || !bodyB || !ballA || !ballB) continue;

                // Skip pocketed or removed balls
                if (ballA.userData.isPocketed || ballA.userData.isBeingRemoved) continue;
                if (ballB.userData.isPocketed || ballB.userData.isBeingRemoved) continue;

                try {
                    const posA = bodyA.translation();
                    const posB = bodyB.translation();

                    // Distance between centers
                    const dx = posB.x - posA.x;
                    const dz = posB.z - posA.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);

                    // Check for collision
                    if (dist < minDist && dist > 0.0001) {
                        const velA = bodyA.linvel();
                        const velB = bodyB.linvel();
                        const angVelA = bodyA.angvel();
                        const angVelB = bodyB.angvel();

                        // Relative velocity - only process if approaching
                        const dvx = velA.x - velB.x;
                        const dvz = velA.z - velB.z;
                        const nx = dx / dist;
                        const nz = dz / dist;
                        const dvn = dvx * nx + dvz * nz;

                        if (dvn > 0.001) {
                            // Initialize or get BallState objects
                            if (!this.ballStates[i]) this.ballStates[i] = new BallState();
                            if (!this.ballStates[j]) this.ballStates[j] = new BallState();

                            const stateA = this.ballStates[i];
                            const stateB = this.ballStates[j];

                            // Sync states from Rapier
                            stateA.position = { x: posA.x, y: posA.y, z: posA.z };
                            stateA.velocity = { x: velA.x, y: velA.y, z: velA.z };
                            stateA.angularVelocity = { x: angVelA.x, y: angVelA.y, z: angVelA.z };

                            stateB.position = { x: posB.x, y: posB.y, z: posB.z };
                            stateB.velocity = { x: velB.x, y: velB.y, z: velB.z };
                            stateB.angularVelocity = { x: angVelB.x, y: angVelB.y, z: angVelB.z };

                            // Calculate collision using physics module (includes throw effect)
                            const result = calculateBallCollision(stateA, stateB);

                            // Apply results back to Rapier bodies
                            bodyA.setLinvel({ x: stateA.velocity.x, y: 0, z: stateA.velocity.z }, true);
                            bodyB.setLinvel({ x: stateB.velocity.x, y: 0, z: stateB.velocity.z }, true);

                            bodyA.setAngvel({
                                x: stateA.angularVelocity.x,
                                y: stateA.angularVelocity.y,
                                z: stateA.angularVelocity.z
                            }, true);
                            bodyB.setAngvel({
                                x: stateB.angularVelocity.x,
                                y: stateB.angularVelocity.y,
                                z: stateB.angularVelocity.z
                            }, true);

                            // Log collision with throw angle info
                            const collisionKey = `${i}-${j}`;
                            if (!this.lastCollisions[collisionKey] || now - this.lastCollisions[collisionKey] > 100) {
                                const relSpeed = Math.sqrt(dvx * dvx + dvz * dvz);
                                if (relSpeed > 0.05) {
                                    const nameA = ballA.userData.isCueBall ? 'Cue' : ballA.userData.name;
                                    const nameB = ballB.userData.isCueBall ? 'Cue' : ballB.userData.name;
                                    this.logCollision(nameA, nameB, relSpeed, velA, velB, posA, posB);
                                    this.lastCollisions[collisionKey] = now;
                                }
                            }
                        }

                        // Separate overlapping balls
                        const overlap = (minDist - dist) / 2 + 0.001;
                        bodyA.setTranslation({
                            x: posA.x - nx * overlap,
                            y: posA.y,
                            z: posA.z - nz * overlap
                        }, true);
                        bodyB.setTranslation({
                            x: posB.x + nx * overlap,
                            y: posB.y,
                            z: posB.z + nz * overlap
                        }, true);
                    }
                } catch (e) { }
            }
        }
    }

    applyRollingFriction(deltaTime = 1 / 60) {
        // ===== ADVANCED SNOOKER PHYSICS WITH SLIDE/ROLL TRANSITION =====
        // Uses physics.js module for realistic ball behavior
        // 
        // KLUCZOWA ZASADA: Nasz BallState jest "source of truth" dla fizyki toczenia.
        // Rapier obsługuje tylko kolizje i pozycję, ale my zarządzamy prędkościami.

        const R = PHYSICS_CONFIG.ball.radius;
        const thresholds = PHYSICS_CONFIG.thresholds;

        for (let i = 0; i < this.ballBodies.length; i++) {
            const body = this.ballBodies[i];
            const ball = this.balls[i];
            if (!body || !ball) continue;

            // Skip pocketed or removed balls
            if (ball.userData.isPocketed || ball.userData.isBeingRemoved) continue;

            try {
                const pos = body.translation();
                const rapierVel = body.linvel();
                const rapierSpeed = Math.sqrt(rapierVel.x * rapierVel.x + rapierVel.z * rapierVel.z);

                // Initialize BallState if needed
                if (!this.ballStates[i]) {
                    this.ballStates[i] = new BallState();
                    this.ballStates[i].position = { x: pos.x, y: pos.y, z: pos.z };
                    this.ballStates[i].velocity = { x: 0, y: 0, z: 0 };
                    this.ballStates[i].angularVelocity = { x: 0, y: 0, z: 0 };
                    this.ballStates[i].phase = 'stationary';
                }
                const state = this.ballStates[i];

                // Aktualizuj pozycję z Rapier (kolizje mogą ją zmienić)
                state.position = { x: pos.x, y: pos.y, z: pos.z };

                // ===== DETEKCJA ZMIANY PRĘDKOŚCI OD KOLIZJI BIL =====
                // Sprawdź czy Rapier zmienił prędkość (od kolizji z inną kulą)
                // UWAGA: NIE używamy tego dla band - mamy własną obsługę odbić w sekcji cushion poniżej
                // Ta detekcja jest teraz tylko dla kolizji bil które obsługuje handleBallCollisions()
                // Wyłączone - handleBallCollisions() już obsługuje kolizje bil
                /*
                const ourSpeed = state.speed;
                const velDiffX = rapierVel.x - state.velocity.x;
                const velDiffZ = rapierVel.z - state.velocity.z;
                const velDiffMag = Math.sqrt(velDiffX * velDiffX + velDiffZ * velDiffZ);
 
                const significantChange = velDiffMag > 0.05 && rapierSpeed > 0.01;
 
                if (significantChange) {
                    state.velocity.x = rapierVel.x;
                    state.velocity.y = 0;
                    state.velocity.z = rapierVel.z;
 
                    state.angularVelocity.x = -rapierVel.z / R * 0.75;
                    state.angularVelocity.z = rapierVel.x / R * 0.75;
                    state.phase = 'sliding';
                }
                */

                // ===== ZATRZYMANIE BILI =====
                const currentSpeed = state.speed;
                if (currentSpeed < thresholds.velocity_stop &&
                    state.angularSpeed < thresholds.angular_stop) {
                    state.velocity = { x: 0, y: 0, z: 0 };
                    state.angularVelocity = { x: 0, y: 0, z: 0 };
                    state.phase = 'stationary';
                    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                    continue;
                }

                // Check if ball is within table bounds (plus margin for cushions)
                // If ball is outside, let it fall naturally (don't force Y or apply rolling friction)
                const boundsMargin = 0.6; // Allow being inside cushion (cushion thickness is 0.5)
                const halfWidth = TABLE_WIDTH / 2 + boundsMargin;
                const halfLength = TABLE_LENGTH / 2 + boundsMargin;

                const inBounds =
                    Math.abs(pos.x - TABLE_CENTER_X) < halfWidth &&
                    Math.abs(pos.z - TABLE_CENTER_Z) < halfLength;

                if (!inBounds) {
                    // Ball is out of bounds - let Rapier handle gravity/falling
                    continue;
                }

                // Utrzymuj bilę na właściwej wysokości (ONLY if in bounds)
                // Tylko delikatnie koryguj - nie teleportuj jeśli różnica jest mała
                const correctY = TABLE_SURFACE_Y + BALL_RADIUS;
                if (pos.y < correctY - 0.001) {
                    // Bila spadła poniżej powierzchni - podnieś ją
                    body.setTranslation({ x: pos.x, y: correctY, z: pos.z }, true);
                    body.setLinvel({ x: state.velocity.x, y: 0, z: state.velocity.z }, true);
                } else if (pos.y > correctY + 0.02) {
                    // Bila unosi się za wysoko - delikatnie sprowadź w dół
                    const newY = pos.y - 0.005; // Stopniowe opadanie
                    body.setTranslation({ x: pos.x, y: Math.max(correctY, newY), z: pos.z }, true);
                }

                // ===== APPLY PHYSICS MODULE UPDATE =====
                // Symulacja tarcia slide/roll, nap effect, spin decay
                updateBallPhysics(state, deltaTime);

                // ===== ZASTOSUJ WYNIKI DO RAPIER =====
                body.setLinvel({ x: state.velocity.x, y: 0, z: state.velocity.z }, true);
                body.setAngvel({
                    x: state.angularVelocity.x,
                    y: state.angularVelocity.y,
                    z: state.angularVelocity.z
                }, true);

                // ===== CUSHION COLLISIONS WITH SPIN EFFECTS =====
                // Check if ball is near a pocket - if so, don't apply cushion physics
                // Zwiększony mnożnik (2.5x radius) pozwala bile wejść do kieszeni bez odbicia od bandy
                let nearPocket = false;
                if (this.pockets) {
                    for (const pocket of this.pockets) {
                        const dx = pos.x - pocket.x;
                        const dz = pos.z - pocket.z;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        if (dist < pocket.radius * 2.5) {
                            nearPocket = true;
                            break;
                        }
                    }
                }

                if (!nearPocket && state.speed > 0.01) {
                    const cushionOffset = BALL_RADIUS + 0.002;
                    const minX = TABLE_CENTER_X - TABLE_WIDTH / 2 + cushionOffset;
                    const maxX = TABLE_CENTER_X + TABLE_WIDTH / 2 - cushionOffset;
                    const minZ = TABLE_CENTER_Z - TABLE_LENGTH / 2 + cushionOffset;
                    const maxZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 - cushionOffset;

                    let bounced = false;
                    let cushionSide = '';
                    const impactSpeed = state.speed;
                    const velBefore = { x: state.velocity.x, z: state.velocity.z };

                    // Get current Y for positioning after bounce
                    const currentY = Math.max(TABLE_SURFACE_Y + BALL_RADIUS, pos.y);

                    // Minimum normal velocity to trigger bounce (prevents glancing shot loops)
                    // At very shallow angles, treat as sliding along cushion instead
                    const minNormalVelocity = 0.05; // m/s - must have some "push" into cushion

                    // Left cushion - ball past boundary AND moving left (negative X) with enough normal velocity
                    if (pos.x < minX && state.velocity.x < -minNormalVelocity) {
                        calculateCushionRebound(state, 'left', impactSpeed);
                        pos.x = minX + 0.005; // Move ball inside table
                        bounced = true;
                        cushionSide = 'Left';
                    } else if (pos.x < minX) {
                        // Ball at cushion but glancing - just push it inside without full rebound
                        pos.x = minX + 0.002;
                    }
                    // Right cushion - ball past boundary AND moving right (positive X)
                    if (pos.x > maxX && state.velocity.x > minNormalVelocity) {
                        calculateCushionRebound(state, 'right', impactSpeed);
                        pos.x = maxX - 0.005;
                        bounced = true;
                        cushionSide = 'Right';
                    } else if (pos.x > maxX) {
                        pos.x = maxX - 0.002;
                    }

                    // Top cushion (negative Z) - ball past boundary AND moving towards top (negative Z)
                    if (pos.z < minZ && state.velocity.z < -minNormalVelocity) {
                        calculateCushionRebound(state, 'top', impactSpeed);
                        pos.z = minZ + 0.005;
                        bounced = true;
                        cushionSide = cushionSide ? cushionSide + '/Top' : 'Top';
                    } else if (pos.z < minZ) {
                        pos.z = minZ + 0.002;
                    }
                    // Bottom cushion (positive Z) - ball past boundary AND moving towards bottom (positive Z)
                    if (pos.z > maxZ && state.velocity.z > minNormalVelocity) {
                        calculateCushionRebound(state, 'bottom', impactSpeed);
                        pos.z = maxZ - 0.005;
                        bounced = true;
                        cushionSide = cushionSide ? cushionSide + '/Bottom' : 'Bottom';
                    } else if (pos.z > maxZ) {
                        pos.z = maxZ - 0.002;
                    }

                    if (bounced) {
                        // Apply updated position and velocities immediately to both Rapier and state
                        body.setTranslation({ x: pos.x, y: currentY, z: pos.z }, true);
                        body.setLinvel({ x: state.velocity.x, y: 0, z: state.velocity.z }, true);
                        body.setAngvel({
                            x: state.angularVelocity.x,
                            y: state.angularVelocity.y,
                            z: state.angularVelocity.z
                        }, true);

                        // Update state position to match
                        state.position.x = pos.x;
                        state.position.z = pos.z;

                        // Log if significant
                        const ballName = ball.userData.isCueBall ? 'Cue' : ball.userData.name;
                        if (impactSpeed > 0.1) {
                            this.logCushionHit(ballName, cushionSide, impactSpeed,
                                velBefore,
                                { x: state.velocity.x, z: state.velocity.z },
                                0, 15);
                        }
                    }
                }
            } catch (e) {
                console.error('Physics error:', e);
            }
        }
    }

    updateCameraMovement() {
        // Smooth WSAD camera movement - very slow and precise
        const acceleration = 0.0008;
        const friction = 0.96;
        const maxSpeed = 0.012;

        // Get camera's forward and right vectors projected onto the XZ plane
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
        right.normalize();

        // Apply acceleration based on key input
        if (this.cameraKeys.w) this.cameraVelocity.add(forward.clone().multiplyScalar(acceleration));
        if (this.cameraKeys.s) this.cameraVelocity.add(forward.clone().multiplyScalar(-acceleration));
        if (this.cameraKeys.a) this.cameraVelocity.add(right.clone().multiplyScalar(-acceleration));
        if (this.cameraKeys.d) this.cameraVelocity.add(right.clone().multiplyScalar(acceleration));

        // Apply friction
        this.cameraVelocity.multiplyScalar(friction);

        // Clamp velocity
        if (this.cameraVelocity.length() > maxSpeed) {
            this.cameraVelocity.normalize().multiplyScalar(maxSpeed);
        }

        // Stop if very slow
        if (this.cameraVelocity.length() < 0.0001) {
            this.cameraVelocity.set(0, 0, 0);
        }

        // Apply movement to both camera and controls target
        if (this.cameraVelocity.length() > 0) {
            this.camera.position.add(this.cameraVelocity);
            this.controls.target.add(this.cameraVelocity);

            // Disable auto-centering when user moves camera
            this.hasCameraTarget = false;

            // Clamp to reasonable bounds around the table
            const maxX = TABLE_LENGTH;
            const maxZ = TABLE_WIDTH + 1;

            this.controls.target.x = Math.max(-maxX, Math.min(maxX, this.controls.target.x));
            this.controls.target.z = Math.max(-maxZ, Math.min(maxZ, this.controls.target.z));
        }
    }

    findSuggestedTarget() {
        // Find the best target ball based on game state
        if (!this.cueBall) return null;

        const cueBallPos = this.cueBall.position;
        let targetBalls = [];

        // Determine which balls are valid targets
        if (this.mustPotColor) {
            // Must pot a color - find closest color ball
            targetBalls = this.balls.filter(b => b.userData.isColor);
        } else {
            // Must pot a red
            targetBalls = this.balls.filter(b => b.userData.isRed);
        }

        if (targetBalls.length === 0) {
            // No reds left, target colors in order
            const colorOrder = ['YELLOW', 'GREEN', 'BROWN', 'BLUE', 'PINK', 'BLACK'];
            for (const colorName of colorOrder) {
                const colorBall = this.balls.find(b => b.userData.type === colorName);
                if (colorBall) {
                    return colorBall;
                }
            }
            return null;
        }

        // Find the ball with clearest path from cue ball
        let bestBall = null;
        let bestScore = -Infinity;

        for (const ball of targetBalls) {
            const dx = ball.position.x - cueBallPos.x;
            const dz = ball.position.z - cueBallPos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            // Check if path is clear
            let pathClear = true;
            const dirX = dx / dist;
            const dirZ = dz / dist;

            for (const otherBall of this.balls) {
                if (otherBall === ball || otherBall.userData.isCueBall) continue;

                // Check if other ball blocks the path
                const odx = otherBall.position.x - cueBallPos.x;
                const odz = otherBall.position.z - cueBallPos.z;
                const proj = odx * dirX + odz * dirZ;

                if (proj > 0 && proj < dist - BALL_RADIUS * 2) {
                    const perpX = odx - proj * dirX;
                    const perpZ = odz - proj * dirZ;
                    const perpDist = Math.sqrt(perpX * perpX + perpZ * perpZ);

                    if (perpDist < BALL_RADIUS * 2.5) {
                        pathClear = false;
                        break;
                    }
                }
            }

            // Score: prefer closer balls with clear paths
            let score = -dist;
            if (pathClear) score += 10;

            if (score > bestScore) {
                bestScore = score;
                bestBall = ball;
            }
        }

        return bestBall;
    }

    centerCameraOnTarget() {
        // WYŁĄCZONE - kamera pozostaje statyczna z widokiem z góry
        // Użytkownik może ręcznie przesuwać kamerę
        return;
    }

    updateCameraAutoCenter() {
        // WYŁĄCZONE - brak automatycznego centrowania
        return;
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Calculate delta time for frame-independent physics
        const now = performance.now();
        const deltaTime = this.lastFrameTime ? Math.min((now - this.lastFrameTime) / 1000, 0.05) : 1 / 60;
        this.lastFrameTime = now;

        // WSAD camera movement
        this.updateCameraMovement();

        // Smooth aim interpolation (runs every frame for super smooth aiming)
        if (this.isAiming && this.cueBall && this.targetAimAngle !== undefined) {
            const smoothing = 0.18;
            let angleDiff = this.targetAimAngle - this.aimAngle;

            // Handle angle wrapping
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

            if (Math.abs(angleDiff) > 0.0001) {
                this.aimAngle += angleDiff * smoothing;

                const cueBallPos = this.cueBall.position;
                this.updateCueStickTransform(cueBallPos, this.aimAngle, this.shotPower);
                this.updateAimLine(cueBallPos, this.aimAngle);
            }

            // Camera follows manually via orbit controls (no automatic first-person)
        }

        // Power charging with right mouse button - ease-in curve for precision
        if (this.isPowerCharging && this.isAiming) {
            const chargeTime = (Date.now() - this.powerChargeStart) / 1000; // seconds
            const cycleTime = 1.8; // Slower cycle for better control

            // Calculate cycling power using triangle wave
            const cyclePosition = (chargeTime % cycleTime) / cycleTime; // 0 to 1
            let linearPower;
            if (cyclePosition < 0.5) {
                // Going up
                linearPower = cyclePosition * 2; // 0 to 1
            } else {
                // Going down
                linearPower = 2 - cyclePosition * 2; // 1 to 0
            }

            // Apply ease-in curve: slow at start, faster at end
            // Using quadratic ease-in: power = t^2 for first half, then adjusted
            let powerNormalized;
            if (linearPower < 0.5) {
                // First 50% of power: very slow (quadratic)
                // Maps 0-0.5 linear to 0-0.25 power
                powerNormalized = 2 * linearPower * linearPower;
            } else {
                // Last 50%: faster (inverse quadratic)
                // Maps 0.5-1.0 linear to 0.25-1.0 power
                const t = (linearPower - 0.5) * 2; // 0 to 1
                powerNormalized = 0.5 + 0.5 * (1 - (1 - t) * (1 - t));
            }

            this.shotPower = powerNormalized * this.maxPower;

            // Update power bar and percent
            const powerPercent = powerNormalized * 100;
            document.getElementById('power-bar').style.width = `${powerPercent}%`;
            document.getElementById('power-percent').textContent = `${Math.round(powerPercent)}%`;

            // Update cue stick pullback AND aim lines based on current power
            if (this.cueBall) {
                const cueBallPos = this.cueBall.position;
                this.updateCueStickTransform(cueBallPos, this.aimAngle, this.shotPower);
                // Aktualizuj linie celowania - ich długość zależy od siły
                this.updateAimLine(cueBallPos, this.aimAngle);
            }
        }

        // Step physics with substeps for stability (more substeps = better cascade handling)
        // At 60 FPS with 8 substeps = 480 physics updates/sec
        // Each substep: dt = 1/480 seconds for proper friction calculation
        const substeps = 8;
        const frictionTimestep = 1 / 480; // Correct timestep for friction per substep
        for (let i = 0; i < substeps; i++) {
            this.world.step();
            // Handle ball-to-ball collisions with realistic physics
            this.handleBallCollisions();
            // Apply rolling friction per substep for accurate deceleration
            this.applyRollingFriction(frictionTimestep);
        }

        // Sync physics to graphics
        this.syncPhysicsToGraphics();

        // Check for pocketed balls
        this.checkPockets();

        // Track ball trajectories for physics log
        this.trackBallTrajectories();

        // Check if balls stopped moving
        const stillMoving = this.checkBallsMoving();

        // Finalize shot data when balls stop
        if (!stillMoving && this.isTrackingShot) {
            this.finalizeCurrentShot();
        }

        // Smooth camera auto-centering
        this.updateCameraAutoCenter();

        // Update HUD
        this.updateHUD();

        // Update controls
        this.controls.update();

        // Render
        this.renderer.render(this.scene, this.camera);
    }
}

// Start the game
window.game = new BilliardGame();
