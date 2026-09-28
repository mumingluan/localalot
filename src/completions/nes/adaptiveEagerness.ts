import { AggressivenessLevel } from './stubs/types';

/** The native inline-edit monitor scores the ten most recent interactions. */
const MAX_INTERACTIONS = 10;

export class AdaptiveEagerness {
    private readonly _recentActions: boolean[] = [];

    record(accepted: boolean): AggressivenessLevel {
        this._recentActions.push(accepted);
        if (this._recentActions.length > MAX_INTERACTIONS) this._recentActions.shift();
        return this.level;
    }

    get level(): AggressivenessLevel {
        if (this._recentActions.length === 0) return AggressivenessLevel.Medium;

        let acceptedWeight = 0;
        let totalWeight = 0;
        this._recentActions.forEach((accepted, index) => {
            const weight = index + 1;
            if (accepted) acceptedWeight += weight;
            totalWeight += weight;
        });
        const rawScore = acceptedWeight / totalWeight;
        const confidence = this._recentActions.length / MAX_INTERACTIONS;
        const score = 0.5 + (rawScore - 0.5) * confidence;
        if (score >= 0.7) return AggressivenessLevel.High;
        if (score >= 0.4) return AggressivenessLevel.Medium;
        return AggressivenessLevel.Low;
    }
}
