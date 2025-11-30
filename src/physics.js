/**
 * SNOOKER PHYSICS ENGINE
 * Realistyczny model fizyki bil snookerowych
 * 
 * Implementuje:
 * - Przejście fazowe poślizg → toczenie
 * - Throw effect przy kolizjach bil
 * - Wpływ rotacji (spin) na odbicia od band
 * - Efekt nap (dryf sukna)
 * - Nieliniowość band
 */

// ============================================
// OBIEKT KONFIGURACYJNY (Stałe globalne)
// ============================================
// PROFESSIONAL SNOOKER PHYSICS - oparte na rzeczywistych pomiarach
// Źródła: World Snooker Tour specifications, Strachan cloth data, Aramith ball specs
export const PHYSICS_CONFIG = {
    world: {
        gravity: 9.81,                    // m/s² - przyspieszenie grawitacyjne
        // TARCIE - PROFESJONALNE SUKNO TURNIEJOWE (Strachan No.10)
        // μ_roll ≈ 0.003-0.006 dla championship cloth - BARDZO niskie!
        // Bila z 2 m/s powinna przetoczyć się 10-15 metrów na profesjonalnym stole
        table_friction_slide: 0.025,      // μ_s - tarcie poślizgowe (niskie - szybkie przejście do rolling)
        table_friction_roll: 0.002,       // μ_r - tarcie toczne - championship cloth (bardzo niskie!)
        // Nap effect - sukno czesane od baulk do black
        nap_drift_factor: 0.0002,         // Wpływ "włosa" sukna - minimalny efekt
        nap_direction: { x: 0, z: -1 }    // Kierunek włosa sukna (od baulk do black)
    },
    ball: {
        mass: 0.142,                      // kg (142g - Super Aramith Pro ball)
        radius: 0.02625,                  // m (średnica 52.5mm)
        // RESTYTUCJA - współczynnik odbicia
        // Aramith phenolic resin balls: e ≈ 0.95-0.98 dla ball-ball (wysokiej jakości bile)
        restitution_ball_ball: 0.98,      // Sprężystość zderzenia kul (phenolic resin) - wyższa!
        restitution_ball_cushion: 0.88,   // Sprężystość bandy (zależy od kąta)
        // TARCIE między kulami - wpływa na throw effect
        friction_ball_ball: 0.04,         // μ między kulami (dla throw effect) - niższe
        friction_cushion: 0.10            // Tarcie o bandę - niższe
    },
    cushion: {
        // Wysokość kontaktu bandy: ~36mm od surface, przy R=26.25mm
        // Punkt kontaktu jest ~7mm nad środkiem kuli = 0.7R
        height_ratio: 0.7,                // Wysokość punktu kontaktu / promień bili
        compression_factor: 0.08,         // Współczynnik ściśliwości gumy bandy (niższy = mniej strat)
        // Kąt-zależna restytucja (glancing shots lose less energy)
        restitution_perpendicular: 0.80,  // CoR przy kącie 90° (prostopadłe uderzenie)
        restitution_glancing: 0.94        // CoR przy kącie ~15° (styczne uderzenie)
    },
    thresholds: {
        velocity_stop: 0.002,             // m/s - prędkość poniżej której bila się zatrzymuje
        angular_stop: 0.03,               // rad/s - prędkość kątowa poniżej której spin zanika
        slip_threshold: 0.008             // Próg przejścia poślizg→toczenie (bardzo mały = szybkie przejście)
    },
    collision: {
        // Czas kontaktu bil ~0.2ms w rzeczywistości
        // Symulujemy jako współczynnik wpływający na throw effect
        contact_duration: 0.0002,         // sekundy (~0.2ms)
        // Współczynnik kumulacji tarcia podczas kontaktu
        friction_accumulation: 1.2        // Mnożnik dla throw effect (niższy = mniej strat energii)
    }
};

// Moment bezwładności kuli pełnej: I = (2/5) * m * R²
export const MOMENT_OF_INERTIA = (2 / 5) * PHYSICS_CONFIG.ball.mass *
    PHYSICS_CONFIG.ball.radius * PHYSICS_CONFIG.ball.radius;

// ============================================
// KLASA STANU BILI (Ball State)
// ============================================
export class BallState {
    constructor() {
        // Pozycja (x, y) na stole
        this.position = { x: 0, y: 0, z: 0 };

        // Prędkość liniowa (vx, vy, vz)
        this.velocity = { x: 0, y: 0, z: 0 };

        // Prędkość kątowa/Rotacja (ωx, ωy, ωz)
        // Kluczowe: nawet na stole 2D, rotacja musi być 3D
        // - ωx, ωz: top spin / screw (rotacja przód/tył i boczna)
        // - ωy: side spin (wpływa na kąt odbicia od bandy)
        this.angularVelocity = { x: 0, y: 0, z: 0 };

        // Faza ruchu: 'sliding' (poślizg) lub 'rolling' (toczenie)
        this.phase = 'stationary';

        // Czas w aktualnej fazie
        this.phaseTime = 0;
    }

    /**
     * Prędkość liniowa (magnitude)
     */
    get speed() {
        return Math.sqrt(
            this.velocity.x * this.velocity.x +
            this.velocity.z * this.velocity.z
        );
    }

    /**
     * Prędkość kątowa (magnitude)
     */
    get angularSpeed() {
        return Math.sqrt(
            this.angularVelocity.x * this.angularVelocity.x +
            this.angularVelocity.y * this.angularVelocity.y +
            this.angularVelocity.z * this.angularVelocity.z
        );
    }

    /**
     * Prędkość obwodowa przy kontakcie z suknem
     * v_surface = R * ω (składowa w płaszczyźnie XZ)
     */
    get surfaceVelocity() {
        const R = PHYSICS_CONFIG.ball.radius;
        // Prędkość punktu kontaktu z suknem
        // ω × r gdzie r = (0, -R, 0) (punkt na dole kuli)
        // (ωx, ωy, ωz) × (0, -R, 0) = (ωz*R, 0, -ωx*R)
        return {
            x: this.angularVelocity.z * R,
            z: -this.angularVelocity.x * R
        };
    }

    /**
     * Względna prędkość poślizgu (slip velocity)
     * Różnica między prędkością liniową a prędkością obwodową
     */
    get slipVelocity() {
        const surface = this.surfaceVelocity;
        return {
            x: this.velocity.x - surface.x,
            z: this.velocity.z - surface.z
        };
    }

    /**
     * Magnitude prędkości poślizgu
     */
    get slipSpeed() {
        const slip = this.slipVelocity;
        return Math.sqrt(slip.x * slip.x + slip.z * slip.z);
    }

    /**
     * Czy bila jest w fazie czystego toczenia?
     * Czyste toczenie gdy v = R*ω (brak poślizgu)
     */
    isRolling() {
        return this.slipSpeed < PHYSICS_CONFIG.thresholds.slip_threshold;
    }
}

// ============================================
// FIZYKA RUCHU - FAZA POŚLIZGU vs TOCZENIA
// ============================================

/**
 * Aktualizuje stan bili z uwzględnieniem przejścia fazowego
 * REALISTYCZNA FIZYKA SNOOKERA - oparta na modelu Marlow/Walker
 * 
 * @param {BallState} state - aktualny stan bili
 * @param {number} dt - krok czasowy (sekundy)
 * @returns {BallState} - nowy stan bili
 */
export function updateBallPhysics(state, dt) {
    const g = PHYSICS_CONFIG.world.gravity;
    const R = PHYSICS_CONFIG.ball.radius;
    const m = PHYSICS_CONFIG.ball.mass;
    const I = MOMENT_OF_INERTIA;

    // Sprawdź czy bila jest w ruchu
    if (state.speed < PHYSICS_CONFIG.thresholds.velocity_stop &&
        state.angularSpeed < PHYSICS_CONFIG.thresholds.angular_stop) {
        state.velocity = { x: 0, y: 0, z: 0 };
        state.angularVelocity = { x: 0, y: 0, z: 0 };
        state.phase = 'stationary';
        return state;
    }

    // Oblicz prędkość poślizgu (slip velocity)
    // Jest to różnica między prędkością liniową a prędkością powierzchni od rotacji
    const slip = state.slipVelocity;
    const slipSpeed = state.slipSpeed;

    // ===== SIŁA TARCIA =====
    // Siła tarcia zależy od fazy ruchu (sliding vs rolling)
    // F = μ * m * g, ale kierunek zależy od fazy

    if (slipSpeed > PHYSICS_CONFIG.thresholds.slip_threshold) {
        // ===== FAZA POŚLIZGU (SLIDING) =====
        // Bila ślizga się po suknie - tarcie działa przeciwnie do kierunku poślizgu
        // Siła tarcia: F = μ_s * m * g, kierunek przeciwny do slip velocity
        state.phase = 'sliding';

        const mu_s = PHYSICS_CONFIG.world.table_friction_slide;
        const frictionAccel = mu_s * g; // Przyspieszenie od tarcia

        // Kierunek poślizgu (znormalizowany)
        const slipDirX = slip.x / slipSpeed;
        const slipDirZ = slip.z / slipSpeed;

        // Siła tarcia zmniejsza prędkość liniową
        // Ale większość energii idzie na nabieranie rotacji (przejście do rolling)
        // Im szybciej bile przejdą w rolling, tym dalej się potoczą
        const decelLinear = frictionAccel * dt;
        state.velocity.x -= slipDirX * decelLinear * 0.15; // Tylko 15% na hamowanie liniowe
        state.velocity.z -= slipDirZ * decelLinear * 0.15;

        // Moment od tarcia zwiększa rotację w kierunku naturalnego toczenia
        // Tarcie przy poślizgu: τ = μ * m * g * R, więc α = τ/I = μ*m*g*R / I
        // Szybkie nabieranie rotacji = szybkie przejście do rolling = mniejsze straty
        const angularAccel = (mu_s * m * g * R) / I;
        const angularChange = angularAccel * dt * 3.0; // 3x szybsze nabieranie rotacji

        // Zwiększ rotację w kierunku naturalnego toczenia
        // Naturalne toczenie: ωx = -vz/R, ωz = vx/R
        const targetAngX = -state.velocity.z / R;
        const targetAngZ = state.velocity.x / R;

        // Przybliżaj rotację do naturalnego toczenia
        const angDiffX = targetAngX - state.angularVelocity.x;
        const angDiffZ = targetAngZ - state.angularVelocity.z;
        const angDiffMag = Math.sqrt(angDiffX * angDiffX + angDiffZ * angDiffZ);

        if (angDiffMag > 0.01) {
            const changeX = (angDiffX / angDiffMag) * angularChange;
            const changeZ = (angDiffZ / angDiffMag) * angularChange;
            state.angularVelocity.x += changeX;
            state.angularVelocity.z += changeZ;
        }
    } else {
        // ===== FAZA TOCZENIA (ROLLING) =====
        // Bila toczy się bez poślizgu - tylko opór toczny
        // W fizyce: a = μ_r * g (stałe opóźnienie, niezależne od prędkości)
        state.phase = 'rolling';

        const mu_r = PHYSICS_CONFIG.world.table_friction_roll;
        const rollingDecel = mu_r * g; // Opór toczny ~0.059 m/s² dla mu_r=0.006

        const speed = state.speed;
        if (speed > 0.001) {
            // Stałe hamowanie (jak w rzeczywistości) - nie proporcjonalne do prędkości!
            // v_new = v - a*dt, gdzie a = μ_r * g
            const deltaV = rollingDecel * dt;
            const newSpeed = Math.max(0, speed - deltaV);

            // Zachowaj kierunek ruchu, tylko zmniejsz prędkość
            if (speed > 0.0001) {
                const scaleFactor = newSpeed / speed;
                state.velocity.x *= scaleFactor;
                state.velocity.z *= scaleFactor;
            }

            // Utrzymuj synchronizację rotacji z prędkością (czyste toczenie)
            state.angularVelocity.x = -state.velocity.z / R;
            state.angularVelocity.z = state.velocity.x / R;
        }
    }

    // ===== SIDE SPIN (ωy) - ENGLISH =====
    // Side spin zanika wolno (tarcie o sukno działa głównie pionowo)
    // Ale wpływa na tor kuli (Magnus-like effect od asymetrycznego tarcia)
    const sideSpinDecayRate = 0.995; // Per-second decay rate - bardzo wolny zanik
    const sideSpinDecay = Math.pow(sideSpinDecayRate, dt * 60);
    state.angularVelocity.y *= sideSpinDecay;

    // ===== SWERVE EFFECT z NIELINIOWĄ ZALEŻNOŚCIĄ OD PRĘDKOŚCI =====
    // Efekt Coriolisa/Magnusa - side spin zakrzywia trajektorię
    // W rzeczywistości zależność jest NIELINIOWA:
    // - Przy wysokich prędkościach: mały swerve (bila "przebija" przez efekt)
    // - Przy średnich prędkościach: maksymalny swerve
    // - Przy niskich prędkościach: swerve maleje (mało energii)
    // Krzywa ma kształt dzwonowy względem prędkości
    if (Math.abs(state.angularVelocity.y) > 0.5 && state.speed > 0.02) {
        const speed = state.speed;
        
        // Nieliniowy współczynnik swerve zależny od prędkości
        // Optimum przy ~1-2 m/s, maleje przy bardzo wolnych i bardzo szybkich
        const optimalSpeed = 1.5; // m/s - prędkość z maksymalnym swerve
        const speedRatio = speed / optimalSpeed;
        
        // Funkcja dzwonowa (Gaussian-like): max przy speedRatio=1
        // exp(-(x-1)²/σ²) gdzie σ kontroluje szerokość
        const sigma = 1.2; // Szerokość krzywej
        const bellCurve = Math.exp(-Math.pow(speedRatio - 1, 2) / (sigma * sigma));
        
        // Dodatkowe tłumienie przy bardzo niskich prędkościach
        const lowSpeedFactor = Math.min(1, speed / 0.3);
        
        // Bazowy współczynnik swerve
        const baseSwerveCoeff = 0.00035;
        
        // Efektywny współczynnik z nieliniową zależnością
        const effectiveSwerveCoeff = baseSwerveCoeff * bellCurve * lowSpeedFactor;
        
        // Siła swerve proporcjonalna do side spin
        const swerveForce = state.angularVelocity.y * effectiveSwerveCoeff * dt;

        // Siła prostopadła do kierunku ruchu
        const perpX = -state.velocity.z / speed;
        const perpZ = state.velocity.x / speed;

        // Aplikuj siłę swerve (również nieliniowo - mniejszy wpływ przy wysokich prędkościach)
        const speedDamping = 1 / (1 + speed * 0.3); // Tłumienie rosnące z prędkością
        state.velocity.x += perpX * swerveForce * speed * speedDamping;
        state.velocity.z += perpZ * swerveForce * speed * speedDamping;
    }

    // ===== EFEKT NAP =====
    // Minimalne oddziaływanie - głównie wpływa na końcowe fazy ruchu
    applyNapEffect(state, dt);

    // Aktualizuj pozycję
    state.position.x += state.velocity.x * dt;
    state.position.z += state.velocity.z * dt;

    state.phaseTime += dt;

    return state;
}

/**
 * Efekt nap - dryf sukna w snookerze
 * Sukno jest czesane w jednym kierunku (od baulk do black)
 * Kule toczące się "pod włos" zwalniają nieznacznie szybciej
 * UWAGA: W rzeczywistości efekt jest subtelny i widoczny głównie przy wolnych kulach
 */
function applyNapEffect(state, dt) {
    const napFactor = PHYSICS_CONFIG.world.nap_drift_factor;
    const napDir = PHYSICS_CONFIG.world.nap_direction;

    // Efekt nap jest znaczący tylko przy wolnym ruchu (< 0.5 m/s)
    if (state.speed < 0.05 || state.speed > 0.5) return;

    const speed = state.speed;
    const velDirX = state.velocity.x / speed;
    const velDirZ = state.velocity.z / speed;

    // Iloczyn skalarny - jak bardzo ruch jest "pod włos"
    const napDot = velDirX * napDir.x + velDirZ * napDir.z;

    // Ruch przeciwny do kierunku nap = większe tarcie
    if (napDot < -0.3) {
        const extraDecel = napFactor * Math.abs(napDot) * PHYSICS_CONFIG.world.gravity * dt;
        state.velocity.x -= velDirX * extraDecel;
        state.velocity.z -= velDirZ * extraDecel;
    }
}

// ============================================
// KOLIZJE KULA-KULA z THROW EFFECT
// ============================================

/**
 * Oblicza wynik kolizji dwóch bil z uwzględnieniem throw effect
 * MODEL: Marlow elastic collision + friction-induced throw
 * 
 * THROW EFFECT: Tarcie między kulami podczas bardzo krótkiego kontaktu (~0.2ms)
 * powoduje boczne "zepchnięcie" bili obiektowej o 1-5° od linii zderzenia.
 * 
 * CONTACT PERSISTENCE: Kontakt trwa ~0.2ms, podczas którego tarcie kumuluje się,
 * zwiększając efekt throw. Symulowane przez współczynnik friction_accumulation.
 * 
 * POPRAWKI:
 * - Dodana korekja penetracji przed obliczeniami kolizji
 * - Bile są najpierw rozdzielane do prawidłowej odległości 2R
 * 
 * @param {BallState} ballA - stan pierwszej bili (zazwyczaj bila biała)
 * @param {BallState} ballB - stan drugiej bili (bila obiektowa)
 * @returns {{ballA: BallState, ballB: BallState}} - nowe stany po kolizji
 */
export function calculateBallCollision(ballA, ballB) {
    const m = PHYSICS_CONFIG.ball.mass;
    const R = PHYSICS_CONFIG.ball.radius;
    const e = PHYSICS_CONFIG.ball.restitution_ball_ball;
    const mu = PHYSICS_CONFIG.ball.friction_ball_ball;
    const I = MOMENT_OF_INERTIA;
    
    // Parametry kontaktu wieloklatkowego
    const contactDuration = PHYSICS_CONFIG.collision.contact_duration;
    const frictionAccum = PHYSICS_CONFIG.collision.friction_accumulation;

    // Wektor od A do B (collision normal)
    let dx = ballB.position.x - ballA.position.x;
    let dz = ballB.position.z - ballA.position.z;
    let dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.0001 || dist > R * 2.5) return { ballA, ballB };

    // Znormalizowana normalna kolizji (od A do B)
    const nx = dx / dist;
    const nz = dz / dist;
    
    // ===== KOREKTA PENETRACJI =====
    // Jeśli bile się przenikają, rozdziel je do prawidłowej odległości 2R
    const minDist = R * 2;
    if (dist < minDist) {
        const penetration = minDist - dist;
        const halfPen = penetration / 2 + 0.0005; // Dodatkowy margines bezpieczeństwa
        
        // Rozdziel bile proporcjonalnie do ich prędkości (szybsza cofa się mniej)
        const speedA = Math.sqrt(ballA.velocity.x * ballA.velocity.x + ballA.velocity.z * ballA.velocity.z);
        const speedB = Math.sqrt(ballB.velocity.x * ballB.velocity.x + ballB.velocity.z * ballB.velocity.z);
        const totalSpeed = speedA + speedB + 0.001; // Unikaj dzielenia przez zero
        
        const ratioA = speedB / totalSpeed; // Szybsza bila (A) cofa się mniej
        const ratioB = speedA / totalSpeed;
        
        ballA.position.x -= nx * penetration * ratioA;
        ballA.position.z -= nz * penetration * ratioA;
        ballB.position.x += nx * penetration * ratioB;
        ballB.position.z += nz * penetration * ratioB;
        
        // Przelicz dystans po korekcie
        dx = ballB.position.x - ballA.position.x;
        dz = ballB.position.z - ballA.position.z;
        dist = Math.sqrt(dx * dx + dz * dz);
    }

    // Wektor styczny (prostopadły do normalnej, w płaszczyźnie XZ)
    const tx = -nz;
    const tz = nx;

    // ===== PRĘDKOŚCI WZGLĘDNE =====
    const dvx = ballA.velocity.x - ballB.velocity.x;
    const dvz = ballA.velocity.z - ballB.velocity.z;

    // Składowa normalna prędkości względnej (prędkość zbliżania)
    const dvn = dvx * nx + dvz * nz;

    // Tylko jeśli bile się zbliżają
    if (dvn <= 0) return { ballA, ballB };

    // Składowa styczna prędkości względnej
    const dvt = dvx * tx + dvz * tz;

    // ===== IMPULS NORMALNY (zderzenie sprężyste) =====
    // Dla równych mas: J_n = (1 + e) * m * v_n / 2
    const normalImpulse = (1 + e) * m * dvn / 2;

    // ===== THROW EFFECT - IMPULS STYCZNY z CONTACT PERSISTENCE =====
    // Tarcie między kulami generuje impuls styczny
    // Ograniczony przez prawo Coulomba: |J_t| ≤ μ * J_n
    // Contact persistence: tarcie kumuluje się przez czas kontaktu (~0.2ms)

    // Wpływ side spinu bili uderzającej na throw
    // Side spin tworzy prędkość powierzchni w punkcie kontaktu
    const surfaceVelFromSpin = ballA.angularVelocity.y * R;
    const totalTangentVel = dvt + surfaceVelFromSpin;

    // Maksymalny impuls tarcia (zwiększony przez contact persistence)
    // Im dłuższy kontakt, tym więcej tarcia się kumuluje
    const maxFrictionImpulse = mu * normalImpulse * frictionAccum;

    // Rzeczywisty impuls tarcia (proporcjonalny do prędkości stycznej, ograniczony)
    let frictionImpulse = 0;
    if (Math.abs(totalTangentVel) > 0.01) {
        const desiredImpulse = m * totalTangentVel * 0.5; // Połowa zmiany prędkości
        frictionImpulse = Math.sign(totalTangentVel) * Math.min(maxFrictionImpulse, Math.abs(desiredImpulse));
        
        // Dodatkowy efekt od czasu kontaktu - przy wolniejszych uderzeniach
        // kontakt trwa relatywnie dłużej (większa deformacja), więc więcej throw
        const speedFactor = Math.min(1.0, 2.0 / (dvn + 0.5)); // Więcej throw przy wolnych uderzeniach
        frictionImpulse *= (1.0 + (speedFactor - 1.0) * 0.3);
    }

    // ===== ZASTOSUJ IMPULSY =====
    // Bile A i B otrzymują przeciwne impulsy

    // Nowe prędkości liniowe
    ballA.velocity.x -= (normalImpulse * nx + frictionImpulse * tx) / m;
    ballA.velocity.z -= (normalImpulse * nz + frictionImpulse * tz) / m;

    ballB.velocity.x += (normalImpulse * nx + frictionImpulse * tx) / m;
    ballB.velocity.z += (normalImpulse * nz + frictionImpulse * tz) / m;

    // ===== PRZENIESIENIE ROTACJI =====
    // Impuls tarcia tworzy moment obrotowy
    // Contact persistence zwiększa transfer rotacji
    const angularChange = frictionImpulse * R / I;

    // Tłumienie side spinu bili A - minimalne
    ballA.angularVelocity.y *= 0.90; // Zachowuje 90% side spin
    ballA.angularVelocity.y -= angularChange * 0.20;

    // Bila B nabywa side spin od throw
    ballB.angularVelocity.y += angularChange * 0.15;

    // ===== ROTACJA BILI OBIEKTOWEJ =====
    // Po kolizji bila obiektowa ma rotację bliską naturalnemu toczeniu
    // Profesjonalne bile phenolic resin mają bardzo mały poślizg po kolizji
    const speedB = Math.sqrt(ballB.velocity.x * ballB.velocity.x + ballB.velocity.z * ballB.velocity.z);
    if (speedB > 0.01) {
        // Początkowa rotacja = prawie naturalne toczenie (92%)
        // Wysokiej jakości bile szybko przechodzą w rolling
        ballB.angularVelocity.x = -ballB.velocity.z / R * 0.92;
        ballB.angularVelocity.z = ballB.velocity.x / R * 0.92;
        ballB.phase = 'sliding'; // Krótka faza sliding, szybko przejdzie w rolling
    }

    // Bila A - minimalne tłumienie rotacji od kolizji
    ballA.angularVelocity.x *= 0.95;
    ballA.angularVelocity.z *= 0.95;
    ballA.phase = 'sliding';

    ballA.phaseTime = 0;
    ballB.phaseTime = 0;

    // Oblicz throw angle dla diagnostyki
    const throwAngle = Math.atan2(Math.abs(frictionImpulse), normalImpulse) * 180 / Math.PI;

    return { ballA, ballB, throwAngle, contactDuration };
}

// ============================================
// KOLIZJE Z BANDĄ - WPŁYW ROTACJI
// ============================================

/**
 * Oblicza odbicie bili od bandy z uwzględnieniem rotacji (side spin)
 * MODEL FIZYCZNY: Kąt-zależna restytucja + wpływ spinu
 * 
 * POPRAWKI:
 * - Energia i CoR są teraz spójne
 * - Łagodniejsza kara za płytkie kąty (próg 8° zamiast 15°, min CoR 0.6)
 * - Realistyczna krzywa CoR oparta na danych eksperymentalnych
 * 
 * @param {BallState} ball - stan bili
 * @param {string} cushion - która banda ('left', 'right', 'top', 'bottom')
 * @param {number} impactSpeed - prędkość uderzenia w bandę
 * @returns {BallState} - nowy stan po odbiciu
 */
export function calculateCushionRebound(ball, cushion, impactSpeed) {
    const R = PHYSICS_CONFIG.ball.radius;
    const heightRatio = PHYSICS_CONFIG.cushion.height_ratio;
    const compression = PHYSICS_CONFIG.cushion.compression_factor;

    // Normalna bandy (wskazuje do wnętrza stołu)
    let normalX = 0, normalZ = 0;
    switch (cushion) {
        case 'left': normalX = 1; break;
        case 'right': normalX = -1; break;
        case 'top': normalZ = 1; break;
        case 'bottom': normalZ = -1; break;
    }

    // Styczna do bandy
    const tangentX = -normalZ;
    const tangentZ = normalX;

    // ===== SKŁADOWE PRĘDKOŚCI =====
    const velNormal = ball.velocity.x * normalX + ball.velocity.z * normalZ;
    const velTangent = ball.velocity.x * tangentX + ball.velocity.z * tangentZ;

    // ===== KĄT PADANIA =====
    // Kąt między prędkością a normalną bandy
    // 0° = prostopadłe uderzenie, 90° = styczne
    const incidenceAngle = Math.atan2(Math.abs(velTangent), Math.abs(velNormal));
    const angleDeg = incidenceAngle * 180 / Math.PI;

    // ===== POPRAWIONA KĄT-ZALEŻNA RESTYTUCJA =====
    // Oparta na rzeczywistych pomiarach snookerowych:
    // - Kąty 0-8°: "płytkie" uderzenie, CoR 0.60-0.75 (bila "ślizga się")
    // - Kąty 8-30°: optymalne odbicie, CoR 0.75-0.90
    // - Kąty 30-60°: dobre odbicie, CoR 0.85-0.92
    // - Kąty 60-90°: styczne, CoR 0.88-0.92
    
    const corPerpendicular = PHYSICS_CONFIG.cushion.restitution_perpendicular; // 0.75
    const corGlancing = PHYSICS_CONFIG.cushion.restitution_glancing; // 0.92
    
    let effectiveCor;
    if (angleDeg < 8) {
        // Bardzo płytkie uderzenie (<8°) - bila ślizga się po bandzie
        // Łagodniejsza kara: CoR 0.60 przy 0°, rośnie do 0.75 przy 8°
        const shallowFactor = angleDeg / 8; // 0 przy 0°, 1 przy 8°
        // Smooth interpolation using cosine for natural feel
        const smoothFactor = 0.5 - 0.5 * Math.cos(shallowFactor * Math.PI);
        effectiveCor = 0.60 + smoothFactor * (corPerpendicular - 0.60);
    } else if (angleDeg < 30) {
        // Średni kąt (8-30°) - dobre odbicie, CoR rośnie
        const midFactor = (angleDeg - 8) / 22; // 0 przy 8°, 1 przy 30°
        effectiveCor = corPerpendicular + midFactor * (0.88 - corPerpendicular);
    } else if (angleDeg < 60) {
        // Szerszy kąt (30-60°) - optymalne odbicie
        const wideFactor = (angleDeg - 30) / 30;
        effectiveCor = 0.88 + wideFactor * (corGlancing - 0.88);
    } else {
        // Styczne uderzenie (>60°) - najlepszy CoR
        effectiveCor = corGlancing;
    }

    // ===== EFEKT KOMPRESJI BANDY =====
    // Mocne uderzenie ściska gumę, zmniejszając CoR - minimalny efekt
    const speedFactor = Math.min(1, impactSpeed / 6); // Łagodniejsza normalizacja
    const compressionLoss = compression * speedFactor * 0.3; // Niższy efekt kompresji
    effectiveCor *= (1 - compressionLoss);

    // Ogranicz CoR do realistycznych wartości (min 0.65)
    effectiveCor = Math.max(0.65, Math.min(0.96, effectiveCor));

    // ===== WPŁYW SIDE SPIN (ωy) =====
    // Side spin zmienia prędkość styczną po odbiciu
    const sideSpin = ball.angularVelocity.y;
    const spinInfluence = sideSpin * R * 0.15; // Mniejszy współczynnik

    // ===== WPŁYW TOP/BACK SPIN =====
    const topBackSpin = ball.angularVelocity.x * tangentZ - ball.angularVelocity.z * tangentX;
    const gripFactor = 1 + topBackSpin * R * heightRatio * 0.012;

    // ===== NOWE PRĘDKOŚCI =====
    // Składowa normalna: odbija się z CoR
    const newVelNormal = -velNormal * effectiveCor;

    // Składowa styczna: zachowana z minimalną stratą
    // Profesjonalne bandy zachowują większość energii stycznej
    let tangentRetention;
    if (angleDeg < 8) {
        // Płytkie kąty - umiarkowane tarcie
        tangentRetention = 0.88 + (angleDeg / 8) * 0.08; // 0.88 przy 0°, 0.96 przy 8°
    } else {
        tangentRetention = 0.97; // Normalne odbicie - minimalna strata
    }
    let newVelTangent = velTangent * tangentRetention * gripFactor + spinInfluence;

    // Złóż składowe z powrotem
    ball.velocity.x = newVelNormal * normalX + newVelTangent * tangentX;
    ball.velocity.z = newVelNormal * normalZ + newVelTangent * tangentZ;

    // ===== ZMIANA ROTACJI PO ODBICIU =====
    // Minimalne tłumienie side spin
    ball.angularVelocity.y *= 0.80; // 80% zachowane

    // Top/back spin prawie nietknięty
    ball.angularVelocity.x *= 0.95;
    ball.angularVelocity.z *= 0.95;

    // Ustaw fazę po odbiciu - szybkie przejście do rolling
    ball.phase = 'sliding';
    ball.phaseTime = 0;

    return ball;
}

// ============================================
// UDERZENIE KIJEM - APLIKACJA SPINU
// ============================================

/**
 * Aplikuje uderzenie kijem z zadanym spinem
 * @param {BallState} ball - stan bili białej
 * @param {number} power - siła uderzenia (0-1 znormalizowana)
 * @param {number} angle - kąt uderzenia w płaszczyźnie XZ (radiany)
 * @param {number} spinX - side spin (-1 do 1, lewo/prawo)
 * @param {number} spinY - top/back spin (-1 do 1, dół=back, góra=top)
 * @param {number} maxSpeed - maksymalna prędkość początkowa
 * @returns {BallState} - stan bili po uderzeniu
 */
export function applyShot(ball, power, angle, spinX, spinY, maxSpeed = 8) {
    const R = PHYSICS_CONFIG.ball.radius;
    const m = PHYSICS_CONFIG.ball.mass;

    // Prędkość początkowa
    const speed = power * maxSpeed;

    // Kierunek uderzenia (zgodny z main.js: sin dla X, cos dla Z)
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);

    // Ustaw prędkość liniową
    ball.velocity.x = dirX * speed;
    ball.velocity.z = dirZ * speed;

    // ===== APLIKACJA SPINU =====
    // Spin zależy od miejsca uderzenia na bili

    // Bazowa rotacja dla naturalnego toczenia (gdy spinY = 0)
    // Dla czystego toczenia: v = R * ω, więc ω = v / R
    // ωx = -vz/R, ωz = vx/R (rotacja wokół osi prostopadłej do ruchu)
    const naturalAngVelX = -ball.velocity.z / R;
    const naturalAngVelZ = ball.velocity.x / R;

    // Top/back spin (spinY): modyfikuje naturalną rotację
    // spinY > 0: topspin (więcej rotacji do przodu)
    // spinY < 0: backspin (rotacja wsteczna)

    // Natural roll rotation magnitude
    const naturalOmega = speed / R;

    // Calculate rotation components based on shot direction
    // Rotation axis is perpendicular to velocity: (-dirZ, 0, dirX)
    const rotAxisX = -dirZ;
    const rotAxisZ = dirX;

    // Apply spin based on tip position
    // spinY ranges -1 (bottom/back) to 1 (top)
    // 0 = center ball (sliding start, no initial rotation except what friction adds quickly)
    // But typically players expect center hit to have some roll or slide. 
    // Let's model it as: 
    // spinY = 1 -> Pure Topspin (Rolling start + extra) -> omega = naturalOmega * 1.5
    // spinY = 0 -> Center Hit (Stun shot) -> omega = 0 (pure slide)
    // spinY = -1 -> Max Backspin -> omega = -naturalOmega * 1.5

    // However, for better feel, let's blend:
    // Center hit usually imparts slight forward rotation due to cue angle, but ideally it's a stun.
    // Let's map spinY directly to rotation relative to natural roll.

    // Factor to convert spinY (-1..1) to angular velocity
    // A full draw shot (spinY=-1) should have significant reverse rotation
    const spinMagnitude = spinY * naturalOmega * 2.5; // 2.5x natural speed for heavy spin
    
    // Dla center ball hit (spinY ~ 0), dodaj niewielką rotację "do przodu"
    // W rzeczywistości kij uderza lekko powyżej środka nawet przy center hit
    // co daje naturalną tendencję do przejścia w toczenie
    const centerBallBoost = spinY === 0 ? naturalOmega * 0.4 : 0; // 40% natural roll dla center hit

    ball.angularVelocity.x = rotAxisX * (spinMagnitude + centerBallBoost);
    ball.angularVelocity.z = rotAxisZ * (spinMagnitude + centerBallBoost);

    // Side spin (spinX): uderzenie po lewej/prawej stronie środka
    // Tworzy rotację wokół osi Y (pionowej)
    // Reduced multiplier - was too aggressive causing excessive swerve
    ball.angularVelocity.y = spinX * speed * 8;

    // Określ fazę początkową
    // Zawsze zaczynamy od poślizgu (nawet przy topspinie, bo rzadko jest idealnie zgrany z prędkością)
    ball.phase = 'sliding';
    ball.phaseTime = 0;

    return ball;
}

// ============================================
// PREDYKCJA TORU (dla linii celowania)
// ============================================

/**
 * Przewiduje tor bili uwzględniając spin
 * @param {BallState} initialState - początkowy stan
 * @param {number} duration - czas symulacji (sekundy)
 * @param {number} dt - krok czasowy
 * @returns {Array} - tablica punktów trajektorii [{x, z, phase}]
 */
export function predictTrajectory(initialState, duration = 2, dt = 0.01) {
    const trajectory = [];
    const state = JSON.parse(JSON.stringify(initialState)); // Deep copy

    const steps = Math.ceil(duration / dt);

    for (let i = 0; i < steps; i++) {
        trajectory.push({
            x: state.position.x,
            z: state.position.z,
            phase: state.phase
        });

        updateBallPhysics(state, dt);

        // Zatrzymaj jeśli bila się zatrzymała
        if (state.speed < PHYSICS_CONFIG.thresholds.velocity_stop) {
            break;
        }
    }

    return trajectory;
}

// ============================================
// DIAGNOSTYKA I DEBUGOWANIE
// ============================================

/**
 * Zwraca informacje diagnostyczne o stanie bili
 */
export function getBallDiagnostics(state) {
    return {
        speed: state.speed.toFixed(4),
        angularSpeed: state.angularSpeed.toFixed(4),
        slipSpeed: state.slipSpeed.toFixed(4),
        phase: state.phase,
        isRolling: state.isRolling(),
        spinType: getSpinDescription(state),
        surfaceVelocity: state.surfaceVelocity,
        kineticEnergy: (0.5 * PHYSICS_CONFIG.ball.mass * state.speed * state.speed).toFixed(6),
        rotationalEnergy: (0.5 * MOMENT_OF_INERTIA * state.angularSpeed * state.angularSpeed).toFixed(6)
    };
}

function getSpinDescription(state) {
    const parts = [];
    const threshold = 1;

    // Top/back spin
    const speed = state.speed;
    if (speed > 0.01) {
        const dirX = state.velocity.x / speed;
        const dirZ = state.velocity.z / speed;

        // Składowa rotacji w kierunku ruchu (top/back)
        const topBack = state.angularVelocity.x * (-dirZ) + state.angularVelocity.z * dirX;
        const naturalRoll = speed / PHYSICS_CONFIG.ball.radius;
        const spinDiff = topBack - naturalRoll;

        if (Math.abs(spinDiff) > threshold) {
            parts.push(spinDiff > 0 ? 'Top spin' : 'Back spin');
        }
    }

    // Side spin
    if (Math.abs(state.angularVelocity.y) > threshold) {
        parts.push(state.angularVelocity.y > 0 ? 'Left side' : 'Right side');
    }

    return parts.length > 0 ? parts.join(' + ') : 'Natural roll';
}

// ============================================
// EKSPORT KONFIGURACJI DLA ZEWNĘTRZNYCH MODUŁÓW
// ============================================

export const PhysicsConstants = {
    BALL_RADIUS: PHYSICS_CONFIG.ball.radius,
    BALL_MASS: PHYSICS_CONFIG.ball.mass,
    BALL_DIAMETER: PHYSICS_CONFIG.ball.radius * 2,
    GRAVITY: PHYSICS_CONFIG.world.gravity,
    FRICTION_SLIDE: PHYSICS_CONFIG.world.table_friction_slide,
    FRICTION_ROLL: PHYSICS_CONFIG.world.table_friction_roll,
    RESTITUTION_BALL: PHYSICS_CONFIG.ball.restitution_ball_ball,
    RESTITUTION_CUSHION: PHYSICS_CONFIG.ball.restitution_ball_cushion,
    MOMENT_OF_INERTIA
};
