import Foundation
import AVFoundation
import Speech

/// Listening (Apple's speech recogniser, streamed to the page as she talks) and speaking
/// (the best voice installed on the phone: Premium, then Enhanced, then default).
@MainActor
final class SpeechController: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = SpeechController()
    var emit: ((String, [String: Any]) -> Void)?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let synth = AVSpeechSynthesizer()
    private var speaking: CheckedContinuation<Void, Never>?
    private var ended = true

    override init() {
        super.init()
        synth.delegate = self
    }

    static func requestSpeechAuthorization() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
    }

    enum Failure: LocalizedError {
        case denied, unavailable
        var errorDescription: String? {
            switch self {
            case .denied: return "Microphone or speech permission denied."
            case .unavailable: return "Speech recognition isn’t available right now."
            }
        }
    }

    func start(lang: String) async throws {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined { _ = await Self.requestSpeechAuthorization() }
        if AVAudioApplication.shared.recordPermission == .undetermined { _ = await AVAudioApplication.requestRecordPermission() }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized, AVAudioApplication.shared.recordPermission == .granted else { throw Failure.denied }
        cleanup()
        stopSpeaking()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) ?? SFSpeechRecognizer(), recognizer.isAvailable else { throw Failure.unavailable }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        request = req
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        engine.prepare()
        try engine.start()
        ended = false
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            Task { @MainActor in
                guard let self else { return }
                if let text { self.emit?("speech", ["text": text, "isFinal": isFinal]) }
                if error != nil || isFinal { self.finish() }
            }
        }
    }

    func stop(discard: Bool) {
        if discard { task?.cancel() } else { request?.endAudio() }
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        if discard { finish() }
    }

    private func finish() {
        guard !ended else { return }
        ended = true
        cleanup()
        emit?("speechend", [:])
    }

    private func cleanup() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request = nil
        task = nil
    }

    // MARK: Speaking

    static func bestVoice() -> AVSpeechSynthesisVoice? {
        let lang = Locale.preferredLanguages.first ?? "en-GB"
        let prefix = String(lang.prefix(2))
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(prefix) }
        let sameRegion = voices.filter { $0.language == lang }
        let pool = sameRegion.isEmpty ? voices : sameRegion
        return pool.first { $0.quality == .premium } ?? pool.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: lang) ?? pool.first
    }

    func speak(_ text: String) async {
        stopSpeaking()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestVoice()
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        u.prefersAssistiveTechnologySettings = false
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            speaking = c
            synth.speak(u)
        }
    }

    func stopSpeaking() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speaking?.resume()
        speaking = nil
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in
            self.speaking?.resume()
            self.speaking = nil
        }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in
            self.speaking?.resume()
            self.speaking = nil
        }
    }
}
