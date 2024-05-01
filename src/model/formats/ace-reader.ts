import crc32 from "buffer-crc32";
import equal from "fast-deep-equal";
import { AceConstants } from "./ace-constants";
import { FormatError } from "./error";
import { Checklist, ChecklistFile, ChecklistGroup, ChecklistItem, ChecklistItem_Type } from "../../../gen/ts/checklist";


export class AceReader {
    private readonly ENCODING = 'latin1';  // equivalent to ISO-8859-1
    private readonly DECODER = new TextDecoder(this.ENCODING);

    private _buf: ArrayBuffer | undefined;
    private _arr: Uint8Array | undefined;
    private _offset = 0;

    constructor(private _file: File) { }

    public async read(): Promise<ChecklistFile> {
        // Format parsing largely inspired by http://github.com/MaggieLeber/checklist
        this._buf = await this._file.arrayBuffer();
        this._arr = new Uint8Array(this._buf);

        let expectedCrc = crc32.signed(Buffer.from(this._buf, 0, this._buf.byteLength - 4));

        let header = this.readBytes(AceConstants.HEADER.byteLength);
        if (!equal(header, AceConstants.HEADER)) {
            throw new FormatError(`Unexpected file header in ${this._file.name}: ${header}`);
        }
        let defaultGroup = this.readBytes(1)[0];
        let defaultChecklist = this.readBytes(1)[0];
        if (!this.consumeLine('')) {
            throw new FormatError(`Unexpected header ending in ${this._file.name}`);
        }

        let name = this.readLine();
        let makeAndModel = this.readLine();
        let aircraftInfo = this.readLine();
        let manufacturerInfo = this.readLine();
        let copyrightInfo = this.readLine();

        let outFile: ChecklistFile = {
            name: name,
            groups: [],
            metadata: {
                defaultGroupIndex: defaultGroup,
                defaultChecklistIndex: defaultChecklist,
                makeAndModel: makeAndModel,
                aircraftInfo: aircraftInfo,
                manufacturerInfo: manufacturerInfo,
                copyrightInfo: copyrightInfo,
            },
        };

        while (!this.consumeLine(AceConstants.FILE_END)) {
            outFile.groups.push(this.readGroup());
        }

        let fileCrc = ~new DataView(this._buf, this._offset, 4).getUint32(0, true);
        if (fileCrc != expectedCrc) {
            throw new FormatError('File failed checksum! Expected ' + expectedCrc.toString(16) + ', file has ' + fileCrc.toString(16));
        }
        return outFile;
    }

    private readGroup(): ChecklistGroup {
        if (!this.consumeBytes(AceConstants.GROUP_HEADER)) {
            throw new FormatError('Bad checklist group header: ' + this.peekLine());
        }

        let group: ChecklistGroup = {
            title: this.readLine(),
            checklists: [],
        };

        while (!this.consumeLine(AceConstants.GROUP_END_HEADER)) {
            group.checklists.push(this.readChecklist());
        }
        return group;
    }

    private readChecklist(): Checklist {
        if (!this.consumeBytes(AceConstants.CHECKLIST_HEADER)) {
            throw new FormatError('Bad checklist header: ' + this.peekLine());
        }

        let checklist: Checklist = {
            title: this.readLine(),
            items: [],
        };

        while (!this.consumeLine(AceConstants.CHECKLIST_END_HEADER)) {
            checklist.items.push(this.readItem());
        }
        return checklist;
    }

    private readItem(): ChecklistItem {
        if (this.consumeLine('')) {
            return {
                type: ChecklistItem_Type.ITEM_SPACE,
                prompt: '',
                expectation: '',
                indent: 0,
                centered: false,
            };
        }

        let typeCode = this.readBytes(1)[0];
        let type = AceConstants.itemTypeForCode(typeCode);
        let indentCode = this.readBytes(1)[0];
        let indent = 0;
        let centered = false;
        if (indentCode === 0x63) { // 'c'
            centered = true;
        } else {
            indent = indentCode - 0x30;
        }
        let prompt = this.readLine();
        let expectation = '';
        if (type === ChecklistItem_Type.ITEM_CHALLENGE_RESPONSE) {
            let splits = prompt.split('~');
            prompt = splits[0];
            if (splits.length == 2) {
                expectation = splits[1]
            } else if (splits.length > 2) {
                expectation = splits.slice(1).join('~');
            }
        }

        return {
            type: type,
            prompt: prompt,
            expectation: expectation,
            indent: indent,
            centered: centered,
        };
    }

    private consumeBytes(expected: Uint8Array): boolean {
        let bytes = this.peekBytes(expected.byteLength);
        if (equal(bytes, expected)) {
            this._offset += expected.byteLength;
            return true;
        }
        return false;
    }
    private readBytes(len: number): Uint8Array {
        let ret = this.peekBytes(len);
        this._offset += len;
        return ret;
    }
    private peekBytes(len: number): Uint8Array {
        let slice = this._arr!.slice(this._offset, this._offset + len);
        if (slice.byteLength != len) {
            throw new FormatError(`Truncated file: expected to read ${len} bytes, only got ${slice.byteLength}`);
        }
        return slice;
    }

    private readLine(): string {
        let line = this.peekLine();
        this._offset += line.length + 2;
        return line;
    }

    private consumeLine(expected: string): boolean {
        let line = this.peekLine();
        if (line === expected) {
            this._offset += line.length + 2;
            return true;
        }
        return false;
    }

    private peekLine(): string {
        // Find the CRLF
        let idx: number;
        for (idx = this._offset; idx < this._arr!.byteLength - 1; idx++) {
            if (this._arr![idx] == 0xd && this._arr![idx + 1] == 0xa) {
                break;
            }
        }
        let line = this.DECODER.decode(this._arr!.slice(this._offset, idx));
        if (idx === this._arr!.byteLength) {
            throw new FormatError(`Truncated file: reached EOF reading line: ${line}`);
        }
        return line;
    }
}