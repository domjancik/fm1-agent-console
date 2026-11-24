// fm1-summarize: summarizes an AI coding agent's reply for listening, with Apple's on-device model (FoundationModels,
// macOS 26). Read aloud (docs/ui-v3.md section 14) runs it when the speech text is too long to read in full.
// Usage: fm1-summarize < text. The summary (2-3 plain sentences) goes to stdout.
// Exit codes: 0 summary printed; 2 the model is unavailable (reason on stderr: Apple Intelligence off, device not
// eligible, model not ready); 3 empty input; 4 the model failed (reason on stderr). Nothing leaves the Mac.
import Foundation
import FoundationModels

func fail(_ code: Int32, _ why: String) -> Never {
  FileHandle.standardError.write("\(why)\n".data(using: .utf8)!)
  exit(code)
}

let model = SystemLanguageModel.default
switch model.availability {
case .available:
  break
case .unavailable(let reason):
  switch reason {
  case .appleIntelligenceNotEnabled: fail(2, "unavailable: Apple Intelligence is off")
  case .deviceNotEligible: fail(2, "unavailable: device not eligible")
  case .modelNotReady: fail(2, "unavailable: model not ready")
  @unknown default: fail(2, "unavailable: \(reason)")
  }
}

let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
if input.isEmpty { fail(3, "empty input") }

let instructions = """
  You summarize the reply of an AI coding agent so a developer can listen to it. Write a concise, neutral summary \
  of two or three short sentences in plain English. Say what the agent did or found and what it needs from the \
  developer, if anything. No markdown, no lists, no code, no file paths unless essential, no preamble.
  """

do {
  let session = LanguageModelSession(instructions: instructions)
  let response = try await session.respond(to: "Summarize this reply for listening:\n\n\(input)")
  let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { fail(4, "empty summary") }
  print(text)
} catch {
  fail(4, "model failed: \(error)")
}
