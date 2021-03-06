[waveguide](../README.md) > [Mutex](../classes/mutex.md)

# Class: Mutex

## Hierarchy

**Mutex**

## Index

### Constructors

* [constructor](mutex.md#constructor)

### Properties

* [acquire](mutex.md#acquire)
* [release](mutex.md#release)
* [sem](mutex.md#sem)

### Methods

* [withPermit](mutex.md#withpermit)
* [alloc](mutex.md#alloc)
* [unsafeAlloc](mutex.md#unsafealloc)

---

## Constructors

<a id="constructor"></a>

### `<Private>` constructor

⊕ **new Mutex**(sem: *[Semaphore](semaphore.md)*): [Mutex](mutex.md)

*Defined in [mutex.ts:21](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L21)*

**Parameters:**

| Name | Type |
| ------ | ------ |
| sem | [Semaphore](semaphore.md) |

**Returns:** [Mutex](mutex.md)

___

## Properties

<a id="acquire"></a>

###  acquire

**● acquire**: *[IO](io.md)<`never`, `void`>*

*Defined in [mutex.ts:20](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L20)*

___
<a id="release"></a>

###  release

**● release**: *[IO](io.md)<`never`, `void`>*

*Defined in [mutex.ts:21](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L21)*

___
<a id="sem"></a>

### `<Private>` sem

**● sem**: *[Semaphore](semaphore.md)*

*Defined in [mutex.ts:23](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L23)*

___

## Methods

<a id="withpermit"></a>

###  withPermit

▸ **withPermit**<`E`,`A`>(io: *[IO](io.md)<`E`, `A`>*): [IO](io.md)<`E`, `A`>

*Defined in [mutex.ts:28](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L28)*

**Type parameters:**

#### E 
#### A 
**Parameters:**

| Name | Type |
| ------ | ------ |
| io | [IO](io.md)<`E`, `A`> |

**Returns:** [IO](io.md)<`E`, `A`>

___
<a id="alloc"></a>

### `<Static>` alloc

▸ **alloc**(): [IO](io.md)<`never`, [Mutex](mutex.md)>

*Defined in [mutex.ts:12](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L12)*

**Returns:** [IO](io.md)<`never`, [Mutex](mutex.md)>

___
<a id="unsafealloc"></a>

### `<Static>` unsafeAlloc

▸ **unsafeAlloc**(): [Mutex](mutex.md)

*Defined in [mutex.ts:16](https://github.com/rzeigler/waveguide/blob/a4eddcf/src/mutex.ts#L16)*

**Returns:** [Mutex](mutex.md)

___

