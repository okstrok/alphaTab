import { PlayerProvider, useScoreDocument } from '@coderline/alphatab-ui';
import { JamView } from '../components/alphajam/JamView';
import { playerSettings, singleSampleDocuments } from '../player/environment';
import { DevGlobals } from '../player/mount';
import { Paths } from '../util/Paths';

const SETTINGS = playerSettings();

const DOCUMENTS = singleSampleDocuments(
    {
        id: 'default',
        fileName: Paths.defaultScore.split('/').pop()!,
        color: 'var(--at-track-indigo)',
        source: { url: Paths.defaultScore }
    },
    { sessionKey: 'alphatab.playground.alphajam.document.v1' }
);

/**
 * alphaJam: play along to a song on a real guitar. The live input (as in the tuner) is compared
 * note by note with one guitar track while the rest of the song plays as the backing.
 */
export function AlphaJamApp() {
    return (
        <PlayerProvider fonts="noto" settings={SETTINGS}>
            <DevGlobals />
            <AlphaJamView />
        </PlayerProvider>
    );
}

function AlphaJamView() {
    const doc = useScoreDocument(DOCUMENTS);
    return <JamView doc={doc} />;
}
