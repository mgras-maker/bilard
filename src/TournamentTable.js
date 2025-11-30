/**
 * TOURNAMENT TABLE - Luksusowy stół turniejowy
 * 
 * Profesjonalny stół snookerowy o wymiarach turniejowych:
 * - Playing area: 3569mm x 1778mm (12-foot table)
 * - Zaokrąglone wejścia do łuz z obłożeniem skórzanym
 * - Wysokiej jakości sukno Strachan No.10
 * - Eleganckie wykończenia mahoniowe
 * - Realistyczne profile band K66
 */

import * as THREE from 'three';

// Tournament table dimensions (same as standard snooker)
export const TOURNAMENT_TABLE = {
    // Playing surface dimensions
    LENGTH: 3.569,           // meters (actual: 3569mm)
    WIDTH: 1.778,            // meters (actual: 1778mm)
    HEIGHT: 0.86,            // height from floor to surface
    
    // Rail and cushion - realistic K66 profile (improved)
    RAIL_WIDTH: 0.055,       // mahogany rail width (sleeker)
    RAIL_HEIGHT: 0.040,      // rail height above cloth
    CUSHION_HEIGHT: 0.0365,  // 36.5mm cushion nose height (exactly 7/10 of ball diameter)
    CUSHION_NOSE_WIDTH: 0.022, // Width of rubber nose
    
    // Pocket dimensions (tournament spec - World Snooker) - improved
    CORNER_POCKET_OPENING: 0.0889,  // 88.9mm corner pocket (3.5 inches exact)
    MIDDLE_POCKET_OPENING: 0.1016,  // 101.6mm middle pocket (4 inches exact)
    POCKET_DEPTH: 0.055,            // deeper pocket cut
    POCKET_FALL_RADIUS: 0.032,      // radius of fall/curve into pocket
    POCKET_SLATE_DROP: 0.018,       // how much slate drops at pocket
    
    // Legs and base
    LEG_HEIGHT: 0.76,        // typical table leg height
    LEG_WIDTH: 0.12,
    
    // Colors - improved for better visibility
    CLOTH_COLOR: 0x006835,           // Tournament green (Strachan 6811)
    CUSHION_CLOTH_COLOR: 0x005530,   // Slightly darker for cushion cloth
    RAIL_COLOR: 0x4a2810,            // Rich mahogany (brighter)
    POCKET_LEATHER: 0x1a0800,        // Dark brown leather (not pure black)
    POCKET_LINER: 0x2a1505,          // Pocket interior (warmer)
    BRASS_COLOR: 0xd4b85b,           // Polished brass (brighter)
    SLATE_COLOR: 0x3a3a3a,           // Slate (lighter for visibility)
    RUBBER_COLOR: 0x252520           // Rubber under cloth
};

/**
 * Creates the tournament table procedurally
 * @param {THREE.Scene} scene - The scene to add the table to
 * @param {number} centerX - Table center X position
 * @param {number} centerZ - Table center Z position
 * @returns {Object} Table data including meshes and pocket positions
 */
export function createTournamentTable(scene, centerX = 0, centerZ = 0) {
    const table = new THREE.Group();
    table.position.set(centerX, 0, centerZ);
    
    const T = TOURNAMENT_TABLE;
    const surfaceY = T.HEIGHT;
    
    // ===== MAIN PLAYING SURFACE (CLOTH) =====
    const clothMaterial = createTournamentClothMaterial();
    const clothGeometry = new THREE.BoxGeometry(T.WIDTH, 0.02, T.LENGTH);
    const cloth = new THREE.Mesh(clothGeometry, clothMaterial);
    cloth.position.set(0, surfaceY - 0.01, 0);
    cloth.receiveShadow = true;
    table.add(cloth);
    
    // ===== SLATE BED =====
    const slateMaterial = new THREE.MeshStandardMaterial({
        color: 0x303030,
        roughness: 0.8,
        metalness: 0.1
    });
    const slateGeometry = new THREE.BoxGeometry(T.WIDTH + 0.02, 0.05, T.LENGTH + 0.02);
    const slate = new THREE.Mesh(slateGeometry, slateMaterial);
    slate.position.set(0, surfaceY - 0.045, 0);
    slate.receiveShadow = true;
    table.add(slate);
    
    // ===== MAHOGANY RAILS WITH INTEGRATED CUSHIONS =====
    const railMaterial = createMahoganyMaterial();
    const cushionClothMaterial = new THREE.MeshStandardMaterial({
        color: T.CUSHION_CLOTH_COLOR,
        roughness: 0.8,
        metalness: 0
    });
    
    // Create rails and cushions together (proper positioning)
    createRealisticRailsAndCushions(table, railMaterial, cushionClothMaterial, T, surfaceY);
    
    // ===== POCKETS WITH LEATHER AND NETS =====
    const pocketData = createRealisticPockets(table, T, surfaceY, centerX, centerZ);
    
    // ===== TABLE FRAME AND LEGS =====
    createTableFrame(table, railMaterial, T, surfaceY);
    createElegantLegs(table, railMaterial, T, surfaceY);
    
    // ===== BRASS FITTINGS =====
    createBrassFittings(table, T, surfaceY);
    
    // ===== DECORATIVE INLAYS =====
    createDecorativeDetails(table, T, surfaceY);
    
    scene.add(table);
    
    return {
        group: table,
        pockets: pocketData.pockets,
        pocketBaskets: pocketData.baskets,
        surfaceY: surfaceY,
        centerX: centerX,
        centerZ: centerZ,
        dimensions: {
            width: T.WIDTH,
            length: T.LENGTH,
            railWidth: T.RAIL_WIDTH
        }
    };
}

/**
 * Creates premium tournament cloth material with subtle weave
 */
function createTournamentClothMaterial() {
    const canvas = document.createElement('canvas');
    const size = 512;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    // Championship green - Strachan No.10 inspired
    const baseR = 0;
    const baseG = 100;
    const baseB = 50;
    
    ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
    ctx.fillRect(0, 0, size, size);
    
    // Elegant diagonal twill weave pattern
    for (let y = 0; y < size; y += 2) {
        for (let x = 0; x < size; x += 2) {
            const weavePhase = ((Math.floor(x / 2) + Math.floor(y / 2)) % 3);
            let brightness = 0;
            if (weavePhase === 0) brightness = 4;
            else if (weavePhase === 1) brightness = -2;
            else brightness = 1;
            
            const g = Math.max(0, Math.min(255, baseG + brightness));
            const b = Math.max(0, Math.min(255, baseB + brightness * 0.5));
            
            ctx.fillStyle = `rgb(${baseR}, ${g}, ${b})`;
            ctx.fillRect(x, y, 2, 2);
        }
    }
    
    // Subtle directional sheen (nap direction)
    const gradient = ctx.createLinearGradient(0, 0, size * 0.2, size);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.012)');
    gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.006)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.01)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    
    const clothTexture = new THREE.CanvasTexture(canvas);
    clothTexture.wrapS = THREE.RepeatWrapping;
    clothTexture.wrapT = THREE.RepeatWrapping;
    clothTexture.repeat.set(12, 6);
    clothTexture.anisotropy = 16;
    
    // Normal map for subtle cloth bump
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = 256;
    normalCanvas.height = 256;
    const nCtx = normalCanvas.getContext('2d');
    
    nCtx.fillStyle = '#8080ff';
    nCtx.fillRect(0, 0, 256, 256);
    
    for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
            const weavePhase = ((Math.floor(x / 2) + Math.floor(y / 2)) % 3);
            const bump = weavePhase === 0 ? 2 : (weavePhase === 1 ? -1 : 0);
            const nx = 128 + bump * 0.5;
            const ny = 128 + bump;
            nCtx.fillStyle = `rgb(${nx}, ${ny}, 255)`;
            nCtx.fillRect(x, y, 2, 2);
        }
    }
    
    const normalTexture = new THREE.CanvasTexture(normalCanvas);
    normalTexture.wrapS = THREE.RepeatWrapping;
    normalTexture.wrapT = THREE.RepeatWrapping;
    normalTexture.repeat.set(24, 12);
    
    return new THREE.MeshStandardMaterial({
        map: clothTexture,
        normalMap: normalTexture,
        normalScale: new THREE.Vector2(0.03, 0.03),
        roughness: 0.8,
        metalness: 0,
        color: 0xffffff
    });
}

/**
 * Creates rich mahogany wood material
 */
function createMahoganyMaterial() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    // Dark mahogany base
    const baseColor = { r: 74, g: 44, b: 10 };
    ctx.fillStyle = `rgb(${baseColor.r}, ${baseColor.g}, ${baseColor.b})`;
    ctx.fillRect(0, 0, 256, 256);
    
    // Wood grain lines
    for (let i = 0; i < 40; i++) {
        const y = Math.random() * 256;
        const width = Math.random() * 3 + 1;
        const darkness = Math.random() * 30 - 15;
        ctx.strokeStyle = `rgba(${baseColor.r + darkness}, ${baseColor.g + darkness * 0.6}, ${baseColor.b + darkness * 0.3}, 0.4)`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(0, y);
        
        // Wavy grain
        for (let x = 0; x < 256; x += 10) {
            ctx.lineTo(x, y + Math.sin(x * 0.05) * 3 + Math.random() * 2);
        }
        ctx.stroke();
    }
    
    // Subtle knots
    for (let i = 0; i < 3; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 15);
        gradient.addColorStop(0, 'rgba(30, 15, 5, 0.4)');
        gradient.addColorStop(0.5, 'rgba(50, 25, 8, 0.2)');
        gradient.addColorStop(1, 'rgba(74, 44, 10, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 256, 256);
    }
    
    const woodTexture = new THREE.CanvasTexture(canvas);
    woodTexture.wrapS = THREE.RepeatWrapping;
    woodTexture.wrapT = THREE.RepeatWrapping;
    
    return new THREE.MeshStandardMaterial({
        map: woodTexture,
        roughness: 0.35,
        metalness: 0.05,
        color: 0x5a3410
    });
}

/**
 * Creates realistic rails and cushions with proper K66 profile
 * Rails are the wooden part, cushions are the rubber/cloth covered part that balls bounce off
 */
function createRealisticRailsAndCushions(table, railMaterial, cushionMaterial, T, surfaceY) {
    const halfWidth = T.WIDTH / 2;
    const halfLength = T.LENGTH / 2;
    
    // Pocket gap sizes (where rails don't exist)
    const cornerPocketCut = T.CORNER_POCKET_OPENING * 1.0;  // Full pocket opening at corners
    const middlePocketCut = T.MIDDLE_POCKET_OPENING * 1.0;  // Full pocket opening at middle
    
    // Rail dimensions
    const railHeight = T.RAIL_HEIGHT;
    const railWidth = T.RAIL_WIDTH;
    
    // Cushion profile dimensions (K66 style)
    const cushionNoseHeight = T.CUSHION_HEIGHT;  // Height of rubber nose from cloth
    const cushionBaseWidth = 0.035;  // Width at base
    const cushionNoseWidth = 0.010; // Width at nose (where ball contacts)
    
    // Calculate segment lengths - segments should end at pocket edges
    // Long rails: from corner pocket to middle pocket (2 segments per side)
    const longSegmentLength = (halfLength - cornerPocketCut/2 - middlePocketCut/2);
    // Short rails: full width minus corner pocket cuts
    const shortSegmentLength = (T.WIDTH - cornerPocketCut * 2);
    
    // =========== LONG RAILS (Right and Left sides, along Z axis) ===========
    
    // Position segments between pockets
    // Corner pocket edge: at halfLength - cornerPocketCut/2
    // Middle pocket edge: at middlePocketCut/2
    // Segment center should be in the middle of these two edges
    const cornerEdge = halfLength - cornerPocketCut/2;
    const middleEdge = middlePocketCut/2;
    const frontSegmentZ = (cornerEdge + middleEdge) / 2;  // Center of front segment
    // Back segment center: between middle pocket and back corner pocket  
    const backSegmentZ = -frontSegmentZ;
    
    // Right side - front segment (positive Z, between front corner and middle)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: halfWidth + railWidth / 2,
        y: surfaceY,
        z: frontSegmentZ,
        length: longSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: 0,  // Along Z axis
        cushionFacing: 'left'  // Cushion faces inward (left = toward center)
    });
    
    // Right side - back segment (negative Z, between middle and back corner)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: halfWidth + railWidth / 2,
        y: surfaceY,
        z: backSegmentZ,
        length: longSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: 0,
        cushionFacing: 'left'
    });
    
    // Left side - front segment (positive Z)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: -halfWidth - railWidth / 2,
        y: surfaceY,
        z: frontSegmentZ,
        length: longSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: 0,
        cushionFacing: 'right'  // Cushion faces inward (right = toward center)
    });
    
    // Left side - back segment (negative Z)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: -halfWidth - railWidth / 2,
        y: surfaceY,
        z: backSegmentZ,
        length: longSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: 0,
        cushionFacing: 'right'
    });
    
    // =========== SHORT RAILS (Front and Back ends, along X axis) ===========
    
    // Front rail (baulk end, positive Z)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: 0,
        y: surfaceY,
        z: halfLength + railWidth / 2,
        length: shortSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: Math.PI / 2,  // Rotated 90 degrees (along X axis)
        cushionFacing: 'back'  // Cushion faces inward (back = toward center)
    });
    
    // Back rail (black spot end, negative Z)
    createRailWithCushion(table, railMaterial, cushionMaterial, {
        x: 0,
        y: surfaceY,
        z: -halfLength - railWidth / 2,
        length: shortSegmentLength,
        railWidth: railWidth,
        railHeight: railHeight,
        cushionHeight: cushionNoseHeight,
        cushionBaseWidth: cushionBaseWidth,
        cushionNoseWidth: cushionNoseWidth,
        rotation: Math.PI / 2,
        cushionFacing: 'front'  // Cushion faces inward (front = toward center)
    });
}

/**
 * Creates a single rail segment with integrated cushion and rounded ends
 */
function createRailWithCushion(table, railMaterial, cushionMaterial, params) {
    const { x, y, z, length, railWidth, railHeight, cushionHeight, cushionBaseWidth, cushionNoseWidth, rotation, cushionFacing } = params;
    
    const group = new THREE.Group();
    
    // === WOODEN RAIL (box with beveled top) ===
    const railGeometry = new THREE.BoxGeometry(railWidth, railHeight, length);
    const rail = new THREE.Mesh(railGeometry, railMaterial);
    rail.position.y = railHeight / 2;
    rail.castShadow = true;
    rail.receiveShadow = true;
    group.add(rail);
    
    // === CUSHION (K66 profile - triangular with curved nose) ===
    // Create 2D profile shape for cushion
    const cushionProfile = new THREE.Shape();
    
    // K66 cushion profile (simplified)
    cushionProfile.moveTo(0, 0);
    cushionProfile.lineTo(cushionNoseWidth * 0.3, cushionHeight * 0.7);
    cushionProfile.quadraticCurveTo(cushionNoseWidth * 0.5, cushionHeight, cushionNoseWidth, cushionHeight * 0.85);
    cushionProfile.lineTo(cushionBaseWidth, cushionHeight * 0.3);
    cushionProfile.lineTo(cushionBaseWidth, 0);
    cushionProfile.closePath();
    
    // Extrude along the length with subtle rounded caps
    const extrudeSettings = {
        steps: 1,
        depth: length,
        bevelEnabled: true,
        bevelThickness: 0.008,
        bevelSize: 0.006,
        bevelSegments: 3,
        bevelOffset: 0
    };
    
    const cushionGeometry = new THREE.ExtrudeGeometry(cushionProfile, extrudeSettings);
    cushionGeometry.translate(-cushionBaseWidth / 2, 0, -length / 2);
    
    const cushion = new THREE.Mesh(cushionGeometry, cushionMaterial);
    
    // Position cushion relative to rail based on facing direction
    let cushionOffsetX = 0;
    let cushionRotation = 0;
    
    if (cushionFacing === 'left') {
        cushionOffsetX = -railWidth / 2;
        cushionRotation = 0;
    } else if (cushionFacing === 'right') {
        cushionOffsetX = railWidth / 2;
        cushionRotation = Math.PI;
    } else if (cushionFacing === 'front') {
        cushionOffsetX = -railWidth / 2;
        cushionRotation = 0;
    } else if (cushionFacing === 'back') {
        cushionOffsetX = railWidth / 2;
        cushionRotation = Math.PI;
    }
    
    cushion.rotation.y = cushionRotation;
    cushion.position.set(cushionOffsetX, 0, 0);
    cushion.castShadow = true;
    group.add(cushion);
    
    // Position and rotate the whole group
    group.position.set(x, y, z);
    group.rotation.y = rotation;
    
    table.add(group);
    return group;
}

/**
 * Creates realistic pockets with leather falls and proper geometry
 */
function createRealisticPockets(table, T, surfaceY, centerX, centerZ) {
    const pockets = [];
    const baskets = [];
    
    const halfWidth = T.WIDTH / 2;
    const halfLength = T.LENGTH / 2;
    
    // Materials - improved leather look with warm brown tone
    const leatherMaterial = new THREE.MeshStandardMaterial({
        color: 0x3d2817, // Warm brown leather
        roughness: 0.7,
        metalness: 0.0,
    });
    
    const pocketLinerMaterial = new THREE.MeshStandardMaterial({
        color: T.POCKET_LINER,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide
    });
    
    const brassMaterial = new THREE.MeshStandardMaterial({
        color: 0xd4a84b, // Golden brass
        roughness: 0.2,
        metalness: 0.95
    });
    
    // Corner pocket positions (at corners of playing surface)
    const cornerPositions = [
        { x: halfWidth, z: halfLength, angle: -Math.PI * 0.75, name: 'front-right' },
        { x: -halfWidth, z: halfLength, angle: -Math.PI * 0.25, name: 'front-left' },
        { x: halfWidth, z: -halfLength, angle: Math.PI * 0.75, name: 'back-right' },
        { x: -halfWidth, z: -halfLength, angle: Math.PI * 0.25, name: 'back-left' }
    ];
    
    // Middle pocket positions (on long rails, at center)
    const middlePositions = [
        { x: halfWidth, z: 0, angle: -Math.PI / 2, name: 'middle-right' },
        { x: -halfWidth, z: 0, angle: Math.PI / 2, name: 'middle-left' }
    ];
    
    // Create corner pockets
    cornerPositions.forEach((pos) => {
        createRealisticCornerPocket(table, {
            leatherMaterial,
            pocketLinerMaterial,
            brassMaterial,
            T,
            surfaceY,
            pos
        });
        
        pockets.push({
            x: pos.x + centerX,
            z: pos.z + centerZ,
            radius: T.CORNER_POCKET_OPENING / 2
        });
        baskets.push({
            x: pos.x + centerX,
            y: surfaceY - 0.1,
            z: pos.z + centerZ
        });
    });
    
    // Create middle pockets
    middlePositions.forEach((pos) => {
        createRealisticMiddlePocket(table, {
            leatherMaterial,
            pocketLinerMaterial,
            brassMaterial,
            T,
            surfaceY,
            pos
        });
        
        pockets.push({
            x: pos.x + centerX,
            z: pos.z + centerZ,
            radius: T.MIDDLE_POCKET_OPENING / 2
        });
        baskets.push({
            x: pos.x + centerX,
            y: surfaceY - 0.1,
            z: pos.z + centerZ
        });
    });
    
    return { pockets, baskets };
}

/**
 * Creates a corner pocket - simple black hole
 */
function createRealisticCornerPocket(table, params) {
    const { T, surfaceY, pos } = params;
    
    const pocketGroup = new THREE.Group();
    pocketGroup.position.set(pos.x, surfaceY, pos.z);
    
    const r = T.CORNER_POCKET_OPENING / 2;
    
    // Just the black hole
    const holeGeometry = new THREE.CircleGeometry(r, 32);
    const holeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const hole = new THREE.Mesh(holeGeometry, holeMaterial);
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = 0.002;
    pocketGroup.add(hole);
    
    table.add(pocketGroup);
    return pocketGroup;
}

/**
 * Creates a middle pocket - simple black hole
 */
function createRealisticMiddlePocket(table, params) {
    const { T, surfaceY, pos } = params;
    
    const pocketGroup = new THREE.Group();
    pocketGroup.position.set(pos.x, surfaceY, pos.z);
    
    const r = T.MIDDLE_POCKET_OPENING / 2;
    
    // Just the black hole
    const holeGeometry = new THREE.CircleGeometry(r, 32);
    const holeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const hole = new THREE.Mesh(holeGeometry, holeMaterial);
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = 0.002;
    pocketGroup.add(hole);
    
    table.add(pocketGroup);
    return pocketGroup;
}

/**
 * Creates the table frame beneath the playing surface
 */
function createTableFrame(table, material, T, surfaceY) {
    const frameHeight = 0.12;
    const frameThickness = 0.06;
    
    // Main frame box
    const frameGeometry = new THREE.BoxGeometry(
        T.WIDTH + T.RAIL_WIDTH * 2 + 0.04,
        frameHeight,
        T.LENGTH + T.RAIL_WIDTH * 2 + 0.04
    );
    
    const frame = new THREE.Mesh(frameGeometry, material);
    frame.position.set(0, surfaceY - 0.08, 0);
    frame.castShadow = true;
    frame.receiveShadow = true;
    table.add(frame);
    
    // Decorative molding around frame
    const moldingMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a1c05,
        roughness: 0.4,
        metalness: 0.1
    });
    
    const moldingProfile = new THREE.Shape();
    moldingProfile.moveTo(0, 0);
    moldingProfile.lineTo(0.02, 0);
    moldingProfile.quadraticCurveTo(0.025, 0.005, 0.025, 0.01);
    moldingProfile.lineTo(0.025, 0.02);
    moldingProfile.quadraticCurveTo(0.025, 0.025, 0.02, 0.025);
    moldingProfile.lineTo(0, 0.025);
    moldingProfile.closePath();
    
    // Create molding around the frame
    const halfW = T.WIDTH / 2 + T.RAIL_WIDTH + 0.03;
    const halfL = T.LENGTH / 2 + T.RAIL_WIDTH + 0.03;
    
    const moldingPath = new THREE.CurvePath();
    moldingPath.add(new THREE.LineCurve3(
        new THREE.Vector3(-halfW, 0, -halfL),
        new THREE.Vector3(halfW, 0, -halfL)
    ));
    moldingPath.add(new THREE.LineCurve3(
        new THREE.Vector3(halfW, 0, -halfL),
        new THREE.Vector3(halfW, 0, halfL)
    ));
    moldingPath.add(new THREE.LineCurve3(
        new THREE.Vector3(halfW, 0, halfL),
        new THREE.Vector3(-halfW, 0, halfL)
    ));
    moldingPath.add(new THREE.LineCurve3(
        new THREE.Vector3(-halfW, 0, halfL),
        new THREE.Vector3(-halfW, 0, -halfL)
    ));
}

/**
 * Creates elegant carved table legs
 */
function createElegantLegs(table, material, T, surfaceY) {
    const legHeight = T.LEG_HEIGHT;
    const legWidth = T.LEG_WIDTH;
    
    // Leg positions - at corners of frame
    const legPositions = [
        { x: T.WIDTH / 2 + 0.02, z: T.LENGTH / 2 + 0.02 },
        { x: -T.WIDTH / 2 - 0.02, z: T.LENGTH / 2 + 0.02 },
        { x: T.WIDTH / 2 + 0.02, z: -T.LENGTH / 2 - 0.02 },
        { x: -T.WIDTH / 2 - 0.02, z: -T.LENGTH / 2 - 0.02 }
    ];
    
    legPositions.forEach(pos => {
        const leg = createTurnedLeg(material, legWidth, legHeight);
        leg.position.set(pos.x, surfaceY - 0.14 - legHeight / 2, pos.z);
        table.add(leg);
    });
}

function createTurnedLeg(material, width, height) {
    const legGroup = new THREE.Group();
    
    // Main shaft with varying width (lathe-turned effect)
    const points = [];
    const segments = 20;
    
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const y = height * t;
        
        // Varying radius for turned leg profile
        let radius = width / 2;
        
        // Top section - tapered
        if (t < 0.1) {
            radius *= 0.9 + t;
        }
        // Upper bulge
        else if (t < 0.3) {
            radius *= 1.0 + Math.sin((t - 0.1) * Math.PI / 0.2) * 0.15;
        }
        // Middle section - narrower
        else if (t < 0.7) {
            radius *= 0.85;
        }
        // Lower bulge
        else if (t < 0.9) {
            radius *= 0.85 + Math.sin((t - 0.7) * Math.PI / 0.2) * 0.2;
        }
        // Foot - tapered
        else {
            radius *= 1.0 - (t - 0.9) * 0.5;
        }
        
        points.push(new THREE.Vector2(radius, y - height / 2));
    }
    
    const latheGeometry = new THREE.LatheGeometry(points, 16);
    const legMesh = new THREE.Mesh(latheGeometry, material);
    legMesh.castShadow = true;
    legGroup.add(legMesh);
    
    // Foot pad
    const footGeometry = new THREE.CylinderGeometry(width * 0.4, width * 0.35, 0.02, 16);
    const footMaterial = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.9,
        metalness: 0.1
    });
    const foot = new THREE.Mesh(footGeometry, footMaterial);
    foot.position.y = -height / 2 - 0.01;
    legGroup.add(foot);
    
    return legGroup;
}

/**
 * Creates brass fittings and decorative elements
 */
function createBrassFittings(table, T, surfaceY) {
    const brassMaterial = new THREE.MeshStandardMaterial({
        color: T.BRASS_COLOR,
        roughness: 0.3,
        metalness: 0.8
    });
    
    // Corner brackets on the frame (decorative)
    const bracketPositions = [
        { x: T.WIDTH / 2 + 0.02, z: T.LENGTH / 2 + 0.02 },
        { x: -T.WIDTH / 2 - 0.02, z: T.LENGTH / 2 + 0.02 },
        { x: T.WIDTH / 2 + 0.02, z: -T.LENGTH / 2 - 0.02 },
        { x: -T.WIDTH / 2 - 0.02, z: -T.LENGTH / 2 - 0.02 }
    ];
    
    bracketPositions.forEach((pos, i) => {
        const bracketGeometry = new THREE.TorusGeometry(0.015, 0.004, 8, 12, Math.PI / 2);
        const bracket = new THREE.Mesh(bracketGeometry, brassMaterial);
        bracket.position.set(pos.x, surfaceY - 0.03, pos.z);
        bracket.rotation.x = Math.PI / 2;
        bracket.rotation.z = (i % 2 === 0 ? 1 : -1) * Math.PI / 4 + (i < 2 ? 0 : Math.PI);
        table.add(bracket);
    });
    
    // No pocket rings - they look bad on the table surface
}

/**
 * Creates decorative details like spot markers
 * Disabled for cleaner look - spots are very small and barely visible anyway
 */
function createDecorativeDetails(table, T, surfaceY) {
    // Spot markers and baulk line disabled for cleaner appearance
    // They were creating visual clutter
    return;
    
    /*
    // Spot markers on cloth
    const spotMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const spotGeometry = new THREE.CircleGeometry(0.005, 16);
    
    // D marker and baulk line would be drawn on cloth texture
    // For now, add the main spot positions as subtle markers
    
    const spotPositions = [
        { x: 0, z: 0 },                                          // Blue spot (center)
        { x: 0, z: -T.LENGTH / 4 },                              // Pink spot
        { x: 0, z: -T.LENGTH / 2 + 0.324 },                      // Black spot
        { x: 0, z: T.LENGTH / 2 - 0.737 }                        // Brown spot (baulk)
    ];
    
    spotPositions.forEach(pos => {
        const spot = new THREE.Mesh(spotGeometry, spotMaterial);
        spot.position.set(pos.x, surfaceY + 0.001, pos.z);
        spot.rotation.x = -Math.PI / 2;
        table.add(spot);
    });
    
    // Baulk line (subtle)
    const baulkLineGeometry = new THREE.PlaneGeometry(T.WIDTH - 0.1, 0.003);
    const baulkLineMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xffffff,
        transparent: true,
        opacity: 0.3
    });
    const baulkLine = new THREE.Mesh(baulkLineGeometry, baulkLineMaterial);
    baulkLine.position.set(0, surfaceY + 0.001, T.LENGTH / 2 - 0.737);
    baulkLine.rotation.x = -Math.PI / 2;
    table.add(baulkLine);
    
    // D semicircle (simplified as arc)
    const dRadius = 0.292;
    const dCurve = new THREE.EllipseCurve(0, 0, dRadius, dRadius, Math.PI / 2, -Math.PI / 2, false);
    const dPoints = dCurve.getPoints(32);
    const dGeometry = new THREE.BufferGeometry().setFromPoints(dPoints);
    const dMaterial = new THREE.LineBasicMaterial({ 
        color: 0xffffff,
        transparent: true,
        opacity: 0.3
    });
    const dLine = new THREE.Line(dGeometry, dMaterial);
    dLine.position.set(0, surfaceY + 0.001, T.LENGTH / 2 - 0.737);
    dLine.rotation.x = -Math.PI / 2;
    table.add(dLine);
    */
}

export default { createTournamentTable, TOURNAMENT_TABLE };
