
const BALL_RADIUS = 0.02625;
const g = 9.81;
const rollingResistance = 0.006;
const deceleration = rollingResistance * g;
const dt = 1 / 120;

// Cushion setup
const TABLE_LENGTH = 3.469;
const TABLE_CENTER_Z = -1.88;
const cushionOffset = BALL_RADIUS + 0.002;
const maxZ = TABLE_CENTER_Z + TABLE_LENGTH / 2 - cushionOffset; // -0.17375

// Initial state from trajectory t=115
// z = 1.37 (Relative) -> Absolute = -1.88 + 1.37 = -0.51
// vz = 1.17
// angVelX = -45 (approx)

function simulateCushionHit() {
    let z = -0.51;
    let vz = 1.17;
    let angVelX = -45;
    let time = 0;

    console.log(`Starting simulation: z=${z.toFixed(4)}, vz=${vz.toFixed(4)}, maxZ=${maxZ.toFixed(4)}`);

    for (let i = 0; i < 200; i++) { // Run for ~1.6 seconds
        // 1. Move
        z += vz * dt;

        // 2. Friction
        const speed = Math.abs(vz);
        const speedLoss = deceleration * dt;
        let newSpeed = Math.max(0, speed - speedLoss);
        if (vz > 0) vz = newSpeed;
        else vz = -newSpeed;

        // 3. Spin
        const naturalAngX = -vz / BALL_RADIUS;
        const spinDiffX = angVelX - naturalAngX;
        const spinDiffMag = Math.abs(spinDiffX);

        if (spinDiffMag > 1.0) {
            // Fix: Normalize direction and cap acceleration
            const accel = Math.min(0.5, spinDiffMag * 0.02);
            const velocityChange = accel * dt;

            // Direction: spinDiffX / spinDiffMag
            // vz -= direction * velocityChange
            vz -= (spinDiffX / spinDiffMag) * velocityChange;

            const spinDecay = 0.95;
            angVelX = angVelX * spinDecay + naturalAngX * (1 - spinDecay);
        } else {
            angVelX = naturalAngX;
        }

        // 4. Cushion Collision
        if (z > maxZ && vz > 0.01) {
            console.log(`[${time.toFixed(3)}] Cushion Hit! z=${z.toFixed(4)}, vz=${vz.toFixed(4)}`);
            vz = -vz * 0.85;
            z = maxZ - 0.002;
            console.log(`   -> Bounced: z=${z.toFixed(4)}, vz=${vz.toFixed(4)}`);
        }

        time += dt;

        // Log every 10 steps or if interesting
        if (i % 10 === 0 || z > maxZ - 0.05) {
            console.log(`t=${time.toFixed(3)} z=${z.toFixed(4)} vz=${vz.toFixed(4)} angVelX=${angVelX.toFixed(2)}`);
        }
    }
}

simulateCushionHit();
