import '@coderline/alphatab-ui/styles/tokens.scss';
import { Tuner } from '../components/devtest/Tuner';

/**
 * DevTest: live guitar input for alphaTab.
 *
 * Today it is a tuner. The audio capture (`GuitarInput`) and pitch detection (`PitchDetector`)
 * are kept independent of the UI so a later play-along mode can compare what is played with
 * the notes of an alphaTab score during playback.
 */
export function DevTestApp() {
    return <Tuner />;
}
