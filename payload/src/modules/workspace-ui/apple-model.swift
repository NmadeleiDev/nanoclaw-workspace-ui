import Foundation
import FoundationModels

struct Request: Decodable {
    let action: String
    let prompt: String?
    let instructions: String?
    let maxTokens: Int?
}

@main struct AppleUtilityModel {
    static func emit(_ value: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        } catch {
            FileHandle.standardError.write(Data("Cannot encode model response\n".utf8))
        }
    }

    static func main() async {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let request = try JSONDecoder().decode(Request.self, from: data)
            if #available(macOS 26.4, *) {
                let model = SystemLanguageModel.default
                guard model.isAvailable else {
                    emit(["available": false, "error": "Apple Intelligence model unavailable: \(model.availability). Enable Apple Intelligence in System Settings and wait for its model download."])
                    return
                }
                if request.action == "status" {
                    emit(["available": true, "contextSize": model.contextSize, "provider": "Apple on-device"])
                    return
                }
                let instructions = request.instructions ?? "Summarize the supplied text faithfully. Do not invent facts."
                let prompt = request.prompt ?? ""
                let outputBudget = min(1536, max(64, request.maxTokens ?? 1024))
                let inputTokens = try await model.tokenCount(for: Prompt(prompt))
                let instructionTokens = try await model.tokenCount(for: Instructions(instructions))
                guard inputTokens + instructionTokens + outputBudget + 128 < model.contextSize else {
                    emit(["error": "context_limit", "contextSize": model.contextSize, "inputTokens": inputTokens + instructionTokens])
                    return
                }
                let session = LanguageModelSession(model: model, tools: [], instructions: instructions)
                let response = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.2, maximumResponseTokens: outputBudget))
                emit(["text": response.content, "inputTokens": inputTokens + instructionTokens, "contextSize": model.contextSize])
            } else {
                emit(["available": false, "error": "Apple on-device utilities require macOS 26.4 or newer."])
            }
        } catch {
            emit(["error": String(describing: error)])
        }
    }
}
